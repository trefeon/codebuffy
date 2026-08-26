import type { Hono } from "hono";
import type { UpstreamChunk } from "../upstream/types";
import { streamSSE } from "hono/streaming";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Pool } from "../pool/types";
import type { UpstreamClient } from "../upstream/client";
import type { Credential } from "../credentials/types";
import { UpstreamError } from "../upstream/errors";
import { parseResponsesRequest } from "../adapters/responses/parser";
import { ParseError } from "../ir/types";
import { projectIRRequest } from "../adapters/responses/projection";
import type { ProjectionMode } from "../adapters/responses/projection";
import { aggregateStream } from "../adapters/openai-chat/aggregator";
import { toUpstreamRequest } from "../ir/types";
import {
  buildResponsesResponse,
  formatResponsesSSE,
  responsesSSEFromUpstream,
} from "../adapters/responses/emitter";
import { randomBytes } from "node:crypto";
import { pushFromUpstreamChunk } from "../observability/usage";
import { ensureLeadingSystem } from "../ir/ensure-leading-system";

function generateId(prefix = "resp"): string {
  const sep = prefix.endsWith("_") || prefix.endsWith("-") ? "" : "_";
  return `${prefix}${sep}${randomBytes(12).toString("hex")}`;
}

function mapUpstreamErrorToHttp(err: UpstreamError): { status: number; body: unknown } {
  const code = err.code;
  if (code === 11101 || code === 11128) {
    return { status: 400, body: { error: { message: err.message, type: "invalid_request_error", code: String(code) } } };
  }
  if (code === 11140) {
    return { status: 403, body: { error: { message: err.message, type: "permission_error", code: String(code) } } };
  }
  if (code === 14018) {
    return { status: 429, body: { error: { message: err.message, type: "rate_limit_error", code: String(code) } } };
  }
  if (code === 401 || code === 403) {
    return {
      status: Number(code),
      body: { error: { message: err.message, type: code === 401 ? "authentication_error" : "permission_error", code: String(code) } },
    };
  }
  if (code === 429) {
    return { status: 429, body: { error: { message: err.message, type: "rate_limit_error", code: "rate_limit_exceeded" } } };
  }
  if (typeof code === "number" && code >= 500) {
    return { status: code, body: { error: { message: err.message, type: "api_error", code: String(code) } } };
  }
  if (err.httpStatus >= 400 && err.httpStatus < 600) {
    return { status: err.httpStatus, body: { error: { message: err.message, type: "api_error", code: String(code) } } };
  }
  return { status: 502, body: { error: { message: err.message, type: "api_error", code: String(code) } } };
}

export interface ResponsesDeps {
  config: Config;
  logger: Logger;
  pool: Pool;
  upstream: UpstreamClient;
  /** Live-token recovery — forced refresh on inference-time 401/403 (one shot). */
  refresh?: { refreshNow(uid: string): Promise<Credential> };
}

export function mountResponsesRoutes(app: Hono, deps: ResponsesDeps): void {
  const { pool, upstream, logger } = deps;

  app.post("/v1/responses", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    let ir;
    try {
      ir = parseResponsesRequest(raw);
    } catch (e) {
      if (e instanceof ParseError) {
        return c.json({ error: { message: e.message, type: "invalid_request_error" } }, 400);
      }
      throw e;
    }
    ir = ensureLeadingSystem(ir);

    // projection handling
    const bodyRec = raw as Record<string, unknown>;
    const queryDry = c.req.query("dry_run") ?? c.req.query("dryRun");
    const isDryRun = queryDry === "true" || bodyRec.dry_run === true || bodyRec.dryRun === true;
    let projectionMode: ProjectionMode | undefined;
    const projRaw = (bodyRec.projection as string | undefined) ?? (bodyRec.mode as string | undefined);
    if (projRaw === "conservative" || projRaw === "aggressive" || projRaw === "off") {
      projectionMode = projRaw as ProjectionMode;
    } else if (projRaw !== undefined) {
      return c.json({ error: { message: `projection: must be conservative, aggressive, or off (got ${projRaw})`, type: "invalid_request_error" } }, 400);
    }
    let projected = ir;
    let dryDiff: unknown = undefined;
    if (isDryRun || projectionMode !== undefined) {
      const mode: ProjectionMode = projectionMode ?? (isDryRun ? "conservative" : "conservative");
      // detect agentic auto? projectIRRequest handles auto via mode conservative with internal agentic detection
      // For explicit mode, pass directly. For dryRun without explicit, use conservative which will auto-upgrade to aggressive if needed.
      const result = projectIRRequest(ir, { mode, dryRun: true });
      projected = result.ir;
      dryDiff = result.dryRunDiff;
      if (isDryRun) {
        return c.json({ projected: { model: projected.model, messages: projected.messages, tools: projected.tools }, diff: dryDiff });
      }
      // otherwise use projected for upstream
    }

    const isStream = ir.stream === true;

    const cred = await pool.pick();
    if (!cred) {
      return c.json({ error: { message: "No credentials available", type: "api_error" } }, 503);
    }

    const upstreamReq = toUpstreamRequest(projected);

    const signal: AbortSignal | undefined =
      (c.req as { raw?: Request }).raw?.signal ?? (c.req as { signal?: AbortSignal }).signal;
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
            const id = generateId("resp");
            const created = Math.floor(Date.now() / 1000);
            for await (const frame of responsesSSEFromUpstream(wrapped, { id, model: projected.model, created })) {
              emitted = true;
              await stream.write(frame);
            }
            if (lastId || lastUsage !== undefined) {
              try {
                pushFromUpstreamChunk({ id: lastId, model: projected.model, usage: lastUsage });
                logger.info({ id: lastId, model: projected.model }, "usage recorded");
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
              await stream.write(formatResponsesSSE({ type: "error", error: mapped.body }));
            } else {
              logger.error({ err }, "stream responses failed");
              await stream.write(formatResponsesSSE({ type: "error", error: { message: "upstream stream failed", type: "api_error" } }));
            }
            break;
          }
        }
      });
    } else {
      const id = generateId("resp");
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
          const aggregated = await aggregateStream(wrapped, { id, model: projected.model, created });
          pool.reportSuccess?.(activeCred.uid);
          const aggRecord = aggregated as Record<string, unknown>;
          const aggUsage = (aggRecord.usage as unknown) ?? lastUsage;
          const aggId = lastId ?? (typeof aggRecord.id === "string" ? (aggRecord.id as string) : undefined);
          try {
            pushFromUpstreamChunk({ id: aggId, model: projected.model, usage: aggUsage });
            logger.info({ id: aggId, model: projected.model }, "usage recorded");
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
          const body = buildResponsesResponse({ content, tool_calls, finish_reason, usage }, { id, model: projected.model, created });
          return c.json(body);
        } catch (err) {
          if (err instanceof UpstreamError) {
            pool.reportFailure?.(activeCred.uid, err.code);
            if (await retryWithFreshToken(err)) continue;
            const mapped = mapUpstreamErrorToHttp(err);
            return c.json(mapped.body, mapped.status as never);
          }
          logger.error({ err }, "responses failed");
          return c.json({ error: { message: "upstream request failed", type: "api_error" } }, 502);
        }
      }
    }
  });

  app.get("/v1/responses/:id", async (c) => {
    const id = c.req.param("id");
    // stub per contract — previous_response_id statefulness deferred
    return c.json({ error: { message: `Response ${id} not found — retrieval not implemented`, type: "invalid_request_error" } }, 404);
  });

  // also handle POST for previous_response_id retrieval via query? keep simple
}
