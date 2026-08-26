import type { Hono } from "hono";
import type { UpstreamChunk } from "../upstream/types";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Pool } from "../pool/types";
import type { UpstreamClient } from "../upstream/client";
import type { Credential } from "../credentials/types";
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
import { pushFromUpstreamChunk } from "../observability/usage";
import { ensureLeadingSystem } from "../ir/ensure-leading-system";

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
  /** Live-token recovery — forced refresh on inference-time 401/403 (one shot). */
  refresh?: { refreshNow(uid: string): Promise<Credential> };
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
    ir = ensureLeadingSystem(ir);
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
        pool.reportFailure?.(cred.uid, err.code);
        const mapped = mapUpstreamErrorToHttp(err);
        return c.json(mapped.body, mapped.status as never);
      }
      throw err;
    }
    let activeCred: Credential = cred;
    let retriedAuth = false;

    // One-shot live-token recovery: a 401/403 surfacing before any byte was
    // sent means the cached AT died early (revoked / clock skew past the
    // isExpiring lead). Force one refresh + rebuild; never restart mid-stream.
    const retryWithFreshToken = async (err: UpstreamError): Promise<boolean> => {
      if (retriedAuth || !deps.refresh) return false;
      if (err.code !== 401 && err.code !== 403) return false;
      retriedAuth = true;
      try {
        activeCred = await deps.refresh.refreshNow(activeCred.uid);
      } catch (refreshErr) {
        logger.warn({ err: refreshErr, uid: activeCred.uid }, "live auth refresh failed; keeping original error");
        return false;
      }
      chunks = upstream.streamChat(upstreamReq, activeCred, signal);
      return true;
    };

    if (isStream) {
      return streamSSE(c, async (stream) => {
        let lastId: string | undefined;
        let lastUsage: unknown;
        let emitted = false;
        for (;;) {
          const wrapped = (async function* () {
            for await (const chunk of chunks) {
              if (typeof chunk.id === "string" && chunk.id.length > 0) lastId = chunk.id;
              if (chunk.usage !== undefined) lastUsage = chunk.usage;
              yield chunk;
            }
          })();
          try {
            const id = generateId("msg");
            for await (const frame of anthropicSSEFromUpstream(wrapped, { id, model: ir.model })) {
              emitted = true;
              await stream.write(frame);
            }
            if (lastId || lastUsage !== undefined) {
              try {
                pushFromUpstreamChunk({ id: lastId, model: ir.model, usage: lastUsage });
                logger.info({ id: lastId, model: ir.model }, "usage recorded");
              } catch (e) {
                logger.warn({ err: e }, "usage push failed");
              }
            }
            pool.reportSuccess?.(activeCred.uid);
            break;
          } catch (err) {
            if (err instanceof UpstreamError) {
              pool.reportFailure?.(activeCred.uid, err.code);
              if (!emitted && (await retryWithFreshToken(err))) continue;
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
            break;
          }
        }
      });
    } else {
      const id = generateId("msg");
      const created = Math.floor(Date.now() / 1000);
      for (;;) {
        let lastId: string | undefined;
        let lastUsage: unknown;
        const wrapped = (async function* () {
          for await (const chunk of chunks) {
            if (typeof chunk.id === "string" && chunk.id.length > 0) lastId = chunk.id;
            if (chunk.usage !== undefined) lastUsage = chunk.usage;
            yield chunk;
          }
        })();
        try {
          const aggregated = await aggregateStream(wrapped, { id, model: ir.model, created });
          pool.reportSuccess?.(activeCred.uid);
          const aggRecord = aggregated as Record<string, unknown>;
          const aggUsage = (aggRecord.usage as unknown) ?? lastUsage;
          const aggId = lastId ?? (typeof aggRecord.id === "string" ? (aggRecord.id as string) : undefined);
          try {
            pushFromUpstreamChunk({ id: aggId, model: ir.model, usage: aggUsage });
            logger.info({ id: aggId, model: ir.model }, "usage recorded");
          } catch (e) {
            logger.warn({ err: e }, "usage push failed");
          }
          const aggChoices = aggRecord.choices as Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string | null }> | undefined;
          const choice = aggChoices?.[0];
          const content: string =
            (choice?.message?.content as string | undefined) ??
            (typeof aggRecord.content === "string" ? (aggRecord.content as string) : "") ??
            "";
          const tool_calls = (choice?.message?.tool_calls as
            | Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
            | undefined) ?? (aggRecord.tool_calls as Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> | undefined);
          const finish_reason: string | null =
            (choice?.finish_reason as string | null | undefined) ??
            (typeof aggRecord.finish_reason === "string" ? (aggRecord.finish_reason as string) : null) ??
            null;
          const usage = aggUsage;
          const body = buildAnthropicResponse(
            { content, tool_calls, finish_reason, usage },
            { id, model: ir.model },
          );
          return c.json(body);
        } catch (err) {
          if (err instanceof UpstreamError) {
            pool.reportFailure?.(activeCred.uid, err.code);
            if (await retryWithFreshToken(err)) continue;
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
