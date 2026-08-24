import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Pool } from "../pool/types";
import type { UpstreamClient } from "../upstream/client";
import { UpstreamError } from "../upstream/errors";
import { parseOpenAIChatRequest, ParseError } from "../adapters/openai-chat/parser";
import { aggregateStream } from "../adapters/openai-chat/aggregator";
import { toUpstreamRequest } from "../ir/types";
import { randomBytes } from "node:crypto";

function generateId(prefix = "chatcmpl"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

function mapUpstreamErrorToHttp(err: UpstreamError): { status: number; body: unknown } {
  const code = err.code;
  // Business codes from research/02+03
  if (code === 11101 || code === 11128) {
    return { status: 400, body: { error: { message: err.message, type: "invalid_request_error", param: null, code: String(code) } } };
  }
  if (code === 11140) {
    return { status: 403, body: { error: { message: err.message, type: "invalid_request_error", param: null, code: String(code) } } };
  }
  if (code === 14018) {
    return { status: 429, body: { error: { message: err.message, type: "insufficient_quota", param: null, code: String(code) } } };
  }
  if (code === 401 || code === 403) return { status: Number(code), body: { error: { message: err.message, type: "invalid_request_error", param: null, code: String(code) } } };
  if (code === 429) return { status: 429, body: { error: { message: err.message, type: "rate_limit_error", param: null, code: "rate_limit_exceeded" } } };
  if (typeof code === "number" && code >= 500) return { status: code, body: { error: { message: err.message, type: "api_error", param: null, code: String(code) } } };
  if (err.httpStatus >= 400 && err.httpStatus < 600) {
    return { status: err.httpStatus, body: { error: { message: err.message, type: "api_error", param: null, code: String(code) } } };
  }
  return { status: 502, body: { error: { message: err.message, type: "api_error", param: null, code: String(code) } } };
}

function normalizeModels(raw: unknown): Array<{ id: string; object: "model"; created: number; owned_by: string }> {
  const now = Math.floor(Date.now() / 1000);
  const toEntry = (id: string) => ({ id, object: "model" as const, created: now, owned_by: "tencent" });

  if (Array.isArray(raw)) {
    return raw
      .map((v) => (typeof v === "string" ? v : (v as { id?: string })?.id))
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map(toEntry);
  }

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidates: unknown[] = [];
    if (Array.isArray(obj.models)) candidates.push(...(obj.models as unknown[]));
    if (Array.isArray(obj.data)) candidates.push(...(obj.data as unknown[]));
    if (obj.model && typeof obj.model === "string") candidates.push(obj.model);
    if (candidates.length > 0) {
      return candidates
        .map((v) => (typeof v === "string" ? v : (v as { id?: string })?.id))
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .map(toEntry);
    }
    // Possibly raw is already { object:"list", data:[...]} shape from upstream
    if (obj.object === "list" && Array.isArray(obj.data)) {
      return (obj.data as unknown[])
        .map((v) => (typeof v === "string" ? v : (v as { id?: string })?.id))
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .map(toEntry);
    }
  }

  // Fallback: at least expose "auto"
  return [toEntry("auto")];
}

export interface OpenAIDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  upstream: UpstreamClient;
}

export function mountOpenAIRoutes(app: Hono, deps: OpenAIDeps): void {
  const { pool, upstream, logger } = deps;

  app.post("/v1/chat/completions", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error", param: null, code: "invalid_request_error" } }, 400);
    }

    let ir;
    try {
      ir = parseOpenAIChatRequest(raw);
    } catch (e) {
      if (e instanceof ParseError) {
        return c.json({ error: { message: e.message, type: "invalid_request_error", param: null, code: e.code } }, 400);
      }
      throw e;
    }

    const isStream = ir.stream === true;

    const cred = await pool.pick();
    if (!cred) {
      return c.json({ error: { message: "No credentials available", type: "server_error", param: null, code: "no_credentials" } }, 503);
    }

    const upstreamReq = toUpstreamRequest(ir);

    try {
      const chunks = upstream.streamChat(upstreamReq, cred);

      if (isStream) {
        // Hono streaming SSE
        return streamSSE(c, async (stream) => {
          try {
            for await (const chunk of chunks) {
              await stream.writeSSE({ data: JSON.stringify(chunk) });
            }
            await stream.writeSSE({ data: "[DONE]" });
          } catch (err) {
            if (err instanceof UpstreamError) {
              const mapped = mapUpstreamErrorToHttp(err);
              await stream.writeSSE({ event: "error", data: JSON.stringify(mapped.body) });
            } else {
              logger.error({ err }, "stream chat failed");
              await stream.writeSSE({ event: "error", data: JSON.stringify({ error: { message: "upstream stream failed", type: "api_error" } }) });
            }
          }
        });
      } else {
        const id = generateId("chatcmpl");
        const created = Math.floor(Date.now() / 1000);
        // Aggregate stream into single JSON
        // Note: upstream always streams; we consume entirely
        const aggregated = await aggregateStream(chunks, { id, model: ir.model, created });
        return c.json(aggregated);
      }
    } catch (err) {
      if (err instanceof UpstreamError) {
        const mapped = mapUpstreamErrorToHttp(err);
        return c.json(mapped.body, mapped.status as 400 | 401 | 403 | 429 | 500 | 502 | 503);
      }
      logger.error({ err }, "chat completions failed");
      return c.json({ error: { message: "upstream request failed", type: "api_error", param: null, code: "upstream_error" } }, 502);
    }
  });

  app.get("/v1/models", async (c) => {
    const cred = await pool.pick();
    if (!cred) {
      return c.json({ error: { message: "No credentials available", type: "server_error", param: null, code: "no_credentials" } }, 503);
    }
    try {
      const raw = await upstream.fetchModels(cred);
      const data = normalizeModels(raw);
      return c.json({ object: "list", data });
    } catch (err) {
      if (err instanceof UpstreamError) {
        const mapped = mapUpstreamErrorToHttp(err);
        return c.json(mapped.body, mapped.status as 400 | 401 | 403 | 429 | 500 | 502 | 503);
      }
      logger.error({ err }, "models fetch failed");
      return c.json({ error: { message: "failed to fetch models", type: "api_error", param: null, code: "upstream_error" } }, 502);
    }
  });

  app.get("/v1/models/:id", async (c) => {
    const id = c.req.param("id");
    const cred = await pool.pick();
    if (!cred) return c.json({ error: { message: "No credentials available", type: "server_error", param: null, code: "no_credentials" } }, 503);
    try {
      const raw = await upstream.fetchModels(cred);
      const data = normalizeModels(raw);
      const found = data.find((m) => m.id === id);
      if (!found) return c.json({ error: { message: `Model ${id} not found`, type: "invalid_request_error", param: "model", code: "model_not_found" } }, 404);
      return c.json(found);
    } catch (err) {
      if (err instanceof UpstreamError) {
        const mapped = mapUpstreamErrorToHttp(err);
        return c.json(mapped.body, mapped.status as 400 | 401 | 403 | 429 | 500 | 502 | 503);
      }
      return c.json({ error: { message: "failed to fetch model", type: "api_error", param: null, code: "upstream_error" } }, 502);
    }
  });
}
