import type { Hono } from "hono";
import type { UpstreamChunk } from "../upstream/types";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Pool } from "../pool/types";
import type { UpstreamClient } from "../upstream/client";
import { UpstreamError } from "../upstream/errors";
import { parseAnthropicRequest } from "../adapters/anthropic/parser";
import { ParseError } from "../ir/types";
import { aggregateStream } from "../adapters/openai-chat/aggregator";
import { toUpstreamRequest } from "../ir/types";
import {
  buildAnthropicResponse,
  formatAnthropicSSE,
  anthropicSSEFromUpstream,
} from "../adapters/anthropic/emitter";
import { randomBytes } from "node:crypto";

function generateId(prefix = "msg"): string {
  const sep = prefix.endsWith("_") || prefix.endsWith("-") ? "" : "_";
  return `${prefix}${sep}${randomBytes(12).toString("hex")}`;
}

function mapUpstreamErrorToHttp(err: UpstreamError): { status: number; body: unknown } {
  const code = err.code;
  if (code === 11101 || code === 11128) {
    return {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: err.message, code: String(code) } },
    };
  }
  if (code === 11140) {
    return {
      status: 403,
      body: { type: "error", error: { type: "permission_error", message: err.message, code: String(code) } },
    };
  }
  if (code === 14018) {
    return {
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: err.message, code: String(code) } },
    };
  }
  if (code === 401 || code === 403) {
    return {
      status: Number(code),
      body: {
        type: "error",
        error: {
          type: code === 401 ? "authentication_error" : "permission_error",
          message: err.message,
          code: String(code),
        },
      },
    };
  }
  if (code === 429) {
    return {
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: err.message, code: "rate_limit_exceeded" } },
    };
  }
  if (typeof code === "number" && code >= 500) {
    return {
      status: code,
      body: { type: "error", error: { type: "api_error", message: err.message, code: String(code) } },
    };
  }
  if (err.httpStatus >= 400 && err.httpStatus < 600) {
    return {
      status: err.httpStatus,
      body: { type: "error", error: { type: "api_error", message: err.message, code: String(code) } },
    };
  }
  return {
    status: 502,
    body: { type: "error", error: { type: "api_error", message: err.message, code: String(code) } },
  };
}

export interface AnthropicDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  upstream: UpstreamClient;
}

export function mountAnthropicRoutes(app: Hono, deps: AnthropicDeps): void {
  const { pool, upstream, logger } = deps;

  app.post("/v1/messages", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } },
        400,
      );
    }

    let ir;
    try {
      ir = parseAnthropicRequest(raw);
    } catch (e) {
      if (e instanceof ParseError) {
        return c.json(
          { type: "error", error: { type: "invalid_request_error", message: e.message } },
          400,
        );
      }
      throw e;
    }

    const isStream = ir.stream === true;

    const cred = await pool.pick();
    if (!cred) {
      return c.json(
        { type: "error", error: { type: "api_error", message: "No credentials available" } },
        503,
      );
    }

    const upstreamReq = toUpstreamRequest(ir);

    const signal: AbortSignal | undefined =
      (c.req as unknown as { raw?: Request }).raw?.signal ??
      (c.req as unknown as { signal?: AbortSignal }).signal ??
      undefined;

    let chunks: AsyncIterable<UpstreamChunk>;
    try {
      chunks = upstream.streamChat(upstreamReq, cred, signal);
    } catch (err) {
      if (err instanceof UpstreamError) {
        const mapped = mapUpstreamErrorToHttp(err);
        return c.json(mapped.body, mapped.status as never);
      }
      throw err;
    }

    if (isStream) {
      return streamSSE(c, async (stream) => {
        try {
          const id = generateId("msg");
          for await (const frame of anthropicSSEFromUpstream(chunks, { id, model: ir.model })) {
            await stream.write(frame);
          }
        } catch (err) {
          if (err instanceof UpstreamError) {
            const mapped = mapUpstreamErrorToHttp(err);
            await stream.write(formatAnthropicSSE("error", mapped.body));
          } else {
            logger.error({ err }, "stream messages failed");
            await stream.write(
              formatAnthropicSSE("error", {
                type: "error",
                error: { type: "api_error", message: "upstream stream failed" },
              }),
            );
          }
        }
      });
    } else {
      try {
        const id = generateId("msg");
        const created = Math.floor(Date.now() / 1000);
        const aggregated = await aggregateStream(chunks, { id, model: ir.model, created });
        const choice = (aggregated as { choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string | null }> }).choices?.[0];
        const content: string =
          (choice?.message?.content as string | undefined) ??
          (aggregated as { content?: string }).content ??
          "";
        const tool_calls = (choice?.message?.tool_calls as
          | Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
          | undefined) ?? (aggregated as { tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }).tool_calls;
        const finish_reason: string | null =
          (choice?.finish_reason as string | null | undefined) ??
          (aggregated as { finish_reason?: string | null }).finish_reason ??
          null;
        const usage = (aggregated as { usage?: unknown }).usage;
        const body = buildAnthropicResponse(
          { content, tool_calls, finish_reason, usage },
          { id, model: ir.model },
        );
        return c.json(body);
      } catch (err) {
        if (err instanceof UpstreamError) {
          const mapped = mapUpstreamErrorToHttp(err);
          return c.json(mapped.body, mapped.status as never);
        }
        logger.error({ err }, "messages failed");
        return c.json(
          { type: "error", error: { type: "api_error", message: "upstream request failed" } },
          502,
        );
      }
    }
  });

  app.post("/v1/messages/count_tokens", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "Invalid JSON body" } },
        400,
      );
    }

    try {
      const r = raw as Record<string, unknown>;
      let text = "";
      const sys = r.system;
      if (typeof sys === "string") text += sys + " ";
      else if (Array.isArray(sys)) {
        for (const b of sys as Array<Record<string, unknown>>) {
          if (b?.type === "text" && typeof b.text === "string") text += b.text + " ";
        }
      }
      const msgs = r.messages;
      if (Array.isArray(msgs)) {
        for (const m of msgs as Array<Record<string, unknown>>) {
          const content = m.content;
          if (typeof content === "string") text += content + " ";
          else if (Array.isArray(content)) {
            for (const b of content as Array<Record<string, unknown>>) {
              if (b?.type === "text" && typeof b.text === "string") text += b.text + " ";
              else if (b?.type === "thinking" && typeof (b as { thinking?: string }).thinking === "string") {
                text += (b as { thinking: string }).thinking + " ";
              } else if (b?.type === "tool_result") {
                const tr = b as { content?: unknown };
                if (typeof tr.content === "string") text += tr.content + " ";
                else if (Array.isArray(tr.content)) {
                  for (const sub of tr.content as Array<Record<string, unknown>>) {
                    if (sub?.type === "text" && typeof sub.text === "string") text += sub.text + " ";
                  }
                }
              }
            }
          }
        }
      }
      if (Array.isArray(r.tools)) {
        for (const t of r.tools as Array<Record<string, unknown>>) {
          if (typeof t.name === "string") text += t.name + " ";
          if (typeof t.description === "string") text += t.description + " ";
        }
      }
      const tokens = text.trim() ? text.trim().split(/\s+/).length : 0;
      return c.json({ input_tokens: tokens });
    } catch {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "count_tokens not implemented" } },
        400,
      );
    }
  });
}
