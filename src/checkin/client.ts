import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Credential } from "../credentials/types.js";
import { buildUpstreamHeaders } from "../upstream/headers.js";
import { UpstreamError, isRetryable } from "../upstream/errors.js";

export interface CheckinResult {
  claimed: boolean;
  credits?: number;
  alreadyClaimed?: boolean;
}

export type FetchFn = typeof fetch;

/**
 * POST /v2/billing/meter/daily-checkin
 *
 * - Auth: Bearer cred.auth.accessToken (via buildUpstreamHeaders for
 *   fingerprint parity with other upstream calls).
 * - Timeout: config.upstreamTimeoutMs via AbortSignal.timeout.
 * - 200: { claimed, credits } or envelope { code:0, data:{ claimed, credits } }
 * - 409: already claimed -> { claimed:false, alreadyClaimed:true }
 * - 401: not retryable auth failure
 * - fetch injection for tests (defaults to global fetch).
 */
export async function performCheckin(
  cred: Credential,
  config: Config,
  logger: Logger,
  fetchFn: FetchFn = fetch,
): Promise<CheckinResult> {
  const base = config.apiBase.replace(/\/+$/, "");
  const url = `${base}/v2/billing/meter/daily-checkin`;

  const headers = buildUpstreamHeaders(cred);
  headers.Accept = "application/json";
  // No body required for daily check-in; ensure content-type not sent empty.
  // Some backends expect JSON; send minimal empty JSON if needed — we omit body.

  const timeoutMs = config.upstreamTimeoutMs;
  const signal = timeoutMs && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  logger.debug({ uid: cred.uid, url }, "performing daily checkin");

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new UpstreamError("ABORT", "checkin request aborted", 0, false, err);
    }
    throw err;
  }

  // 409 already claimed — not an error, map to structured result
  if (res.status === 409) {
    logger.info({ uid: cred.uid, status: 409 }, "daily checkin already claimed");
    // Try to parse credits if present, but don't fail
    try {
      const j = (await res.json()) as { credits?: number; claimed?: boolean };
      if (typeof j.credits === "number") {
        return { claimed: false, alreadyClaimed: true, credits: j.credits };
      }
    } catch {
      // ignore parse failure
    }
    return { claimed: false, alreadyClaimed: true };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: number | string = res.status;
    let msg = text || `checkin http ${res.status}`;
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
    const retryable = isRetryable(res.status) || isRetryable(code);
    // 401 is explicitly not retryable for check-in per spec
    const finalRetryable = res.status === 401 ? false : retryable;
    throw new UpstreamError(code, msg, res.status, finalRetryable, text);
  }

  // 200 — parse claimed/credits
  const ctype = res.headers.get("content-type") ?? "";
  let body: unknown;
  if (ctype.includes("application/json")) {
    const text = await res.text();
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  } else {
    try {
      body = (await res.json()) as unknown;
    } catch {
      body = await res.text().catch(() => "");
    }
  }

  // Unwrap envelope { code:0, data:{ claimed, credits } } if present
  if (
    body !== null &&
    typeof body === "object" &&
    "code" in (body as Record<string, unknown>) &&
    "data" in (body as Record<string, unknown>)
  ) {
    const env = body as { code: number | string; data?: unknown; msg?: string; message?: string };
    if (env.code !== 0) {
      // Business error inside 200 envelope
      throw new UpstreamError(env.code, env.msg ?? env.message ?? "checkin business error", res.status, isRetryable(env.code), env);
    }
    if (env.data !== undefined) body = env.data;
  }

  if (body !== null && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const claimed = typeof obj.claimed === "boolean" ? obj.claimed : true;
    const credits = typeof obj.credits === "number" ? obj.credits : undefined;
    // alreadyClaimed may appear as field in some variants
    const alreadyClaimed = obj.alreadyClaimed === true ? true : undefined;
    return { claimed, credits, alreadyClaimed };
  }

  // Fallback: treat 200 with no body as claimed
  return { claimed: true };
}
