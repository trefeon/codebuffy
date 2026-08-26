import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Credential } from "../credentials/types";
import type { UpstreamChatRequest, UpstreamChunk } from "./types";
import { buildUpstreamHeaders } from "./headers";
import { sanitizeUpstreamBody } from "./sanitize";
import { UpstreamError, isRetryable } from "./errors";

function buildCompositeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  if (external && timeoutSignal) {
    // Prefer native AbortSignal.any when available (Node 20/Bun 1.2+); fallback to manual.
    const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof anyFn === "function") {
      return anyFn.call(AbortSignal, [external, timeoutSignal]);
    }
    const controller = new AbortController();
    const abort = () => {
      // Prefer external reason if available, else timeout reason
      const reason =
        (external as unknown as { reason?: unknown }).reason ??
        (timeoutSignal as unknown as { reason?: unknown }).reason ??
        new DOMException("Aborted", "AbortError");
      if (!controller.signal.aborted) controller.abort(reason);
    };
    if (external.aborted || timeoutSignal.aborted) {
      abort();
    } else {
      external.addEventListener("abort", abort, { once: true });
      timeoutSignal.addEventListener("abort", abort, { once: true });
    }
    return controller.signal;
  }

  return external ?? timeoutSignal;
}

export class UpstreamClient {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Protected indirection so tests can subclass/override without monkey-patching
   * global fetch, and so apiBase can point at a mock Hono/Bun.serve server.
   */
  protected async _fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    return fetch(input, init);
  }

  async fetchModels(credential: Credential): Promise<unknown> {
    const base = (credential.apiBase || this.config.apiBase).replace(/\/+$/, "");
    const url = `${base}/v3/config`;
    const headers = buildUpstreamHeaders(credential);
    headers["Accept"] = "application/json";

    const signal = buildCompositeSignal(undefined, this.config.upstreamTimeoutMs);

    let res: Response;
    try {
      res = await this._fetch(url, { method: "GET", headers, signal });
    } catch (err) {
      // Timeout/abort surfaces as DOMException AbortError — map to UpstreamError
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new UpstreamError("ABORT", "upstream request aborted", 0, false, err);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code: number | string = res.status;
      let msg = text || `upstream http ${res.status}`;
      try {
        const j = JSON.parse(text) as { code?: number | string; msg?: string; message?: string };
        if (j.code !== undefined && j.code !== 0) {
          code = j.code;
          msg = j.msg ?? j.message ?? msg;
        } else if (j.msg) {
          msg = j.msg;
        }
      } catch {
        // keep raw text message
      }
      throw new UpstreamError(code, msg, res.status, isRetryable(res.status) || isRetryable(code), text);
    }

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const text = await res.text();
      try {
        const j = JSON.parse(text) as { code?: number | string; msg?: string; message?: string; data?: unknown };
        if (j.code !== undefined && j.code !== 0) {
          throw new UpstreamError(j.code, j.msg ?? j.message ?? "upstream business error", res.status, isRetryable(j.code), j);
        }
        // Envelope code 0 with data — return data if present else full json
        if (j.code === 0 && j.data !== undefined) return j.data;
        return j;
      } catch (e) {
        if (e instanceof UpstreamError) throw e;
        // Not JSON envelope? Return raw text parsed
        return JSON.parse(text) as unknown;
      }
    }

    // Fallback: try json
    try {
      return (await res.json()) as unknown;
    } catch {
      const text = await res.text().catch(() => "");
      return text;
    }
  }

  async *streamChat(
    req: UpstreamChatRequest,
    credential: Credential,
    signal?: AbortSignal,
  ): AsyncIterable<UpstreamChunk> {
    const base = (credential.apiBase || this.config.apiBase).replace(/\/+$/, "");
    const url = `${base}/v2/chat/completions`;
    const headers = buildUpstreamHeaders(credential);
    headers["Content-Type"] = "application/json";
    headers["Accept"] = "text/event-stream";
    // Force stream:true upstream (stream-only backend)
    const body: Record<string, unknown> = sanitizeUpstreamBody({ ...req, stream: true });
    const compositeSignal = buildCompositeSignal(signal, this.config.upstreamTimeoutMs);

    // Early abort check — terminate cleanly without issuing fetch
    if (compositeSignal?.aborted) {
      return;
    }

    let res: Response;
    try {
      res = await this._fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: compositeSignal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Abort should cancel fetch and terminate generator cleanly (no throw)
        this.logger.info({ uid: credential.uid }, "upstream stream aborted before response");
        return;
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let code: number | string = res.status;
      let msg = text || `upstream http ${res.status}`;
      try {
        const j = JSON.parse(text) as { code?: number | string; msg?: string; message?: string };
        if (j.code !== undefined && j.code !== 0) {
          code = j.code;
          msg = j.msg ?? j.message ?? msg;
        } else if (j.msg) {
          msg = j.msg;
        }
      } catch {
        // keep raw
      }
      throw new UpstreamError(code, msg, res.status, isRetryable(res.status) || isRetryable(code), text);
    }

    // Handle 200 with JSON business envelope (non-stream error inside 200)
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON, nothing to yield
        return;
      }
      if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
        const rec = parsed as { code: number | string; msg?: string; message?: string };
        if (rec.code !== 0) {
          throw new UpstreamError(rec.code, rec.msg ?? rec.message ?? "upstream business error", res.status, isRetryable(rec.code), parsed);
        }
        // code 0 but contains data that is not streaming — nothing to stream
        return;
      }
      // Unexpected json body on streaming endpoint — treat as single chunk if it looks like chunk
      if (parsed && typeof parsed === "object" && "choices" in (parsed as Record<string, unknown>)) {
        yield parsed as UpstreamChunk;
      }
      return;
    }

    if (!res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            this.logger.info({ uid: credential.uid }, "upstream stream aborted during read");
            return;
          }
          throw err;
        }

        if (compositeSignal?.aborted) {
          try {
            await reader.cancel();
          } catch {}
          return;
        }

        if (readResult.done) break;
        buffer += decoder.decode(readResult.value, { stream: true });

        // Process complete lines (those ending with \n). Remainder stays in buffer
        // to handle split chunks across fetch boundaries.
        const lastNL = buffer.lastIndexOf("\n");
        if (lastNL === -1) continue;

        const toProcess = buffer.slice(0, lastNL + 1);
        buffer = buffer.slice(lastNL + 1);
        const lines = toProcess.split("\n");

        for (let rawLine of lines) {
          if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
          if (rawLine === "") continue;
          if (rawLine.startsWith(":")) continue; // heartbeat comment
          if (rawLine.startsWith("event:")) continue;
          if (!rawLine.startsWith("data:")) continue;

          const data = rawLine.slice(5).trimStart();
          if (data === "") continue;
          if (data === "[DONE]") {
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          // Business envelope inside SSE data (some proxies wrap)
          if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
            const rec = parsed as { code: number | string; msg?: string; message?: string; data?: unknown };
            if (rec.code !== 0) {
              throw new UpstreamError(rec.code, rec.msg ?? rec.message ?? "upstream business error", res.status, isRetryable(rec.code), parsed);
            }
            // code 0 envelope — unwrap inner data if it looks like a chunk
            if (rec.data && typeof rec.data === "object" && "choices" in (rec.data as Record<string, unknown>)) {
              yield rec.data as UpstreamChunk;
              continue;
            }
            // envelope with data being primitive — skip
            continue;
          }

          yield parsed as UpstreamChunk;
        }
      }

      // Flush remainder (no trailing newline)
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trimStart();
        if (data !== "" && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data) as unknown;
            if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
              const rec = parsed as { code: number | string; msg?: string; message?: string };
              if (rec.code !== 0) {
                throw new UpstreamError(rec.code, rec.msg ?? rec.message ?? "upstream business error", res.status, isRetryable(rec.code), parsed);
              }
            } else {
              yield parsed as UpstreamChunk;
            }
          } catch (e) {
            if (e instanceof UpstreamError) throw e;
            // ignore parse errors on trailer
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {}
    }
  }
}
