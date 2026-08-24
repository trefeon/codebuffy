/**
 * Upstream error taxonomy.
 *
 * HTTP status codes and business codes inside 200 envelopes share a single
 * retryability table (RETRYABLE_CODES). Business codes observed in the corpus:
 * 11101 missing-system, 11128 moderation, 11140 banned, 14018 quota — of
 * which 11140/14018 are retryable (drive pool rotation). HTTP 401/403/429/5xx
 * are retryable for token refresh / backoff.
 */

/** Codes that justify a retry / credential rotation. */
export const RETRYABLE_CODES = new Set<number>([401, 403, 429, 500, 502, 503, 504, 11140, 14018]);

export class UpstreamError extends Error {
  public readonly code: number | string;
  public readonly httpStatus: number;
  public readonly retryable: boolean;
  public readonly raw?: unknown;

  constructor(
    code: number | string,
    message: string,
    httpStatus: number,
    retryable: boolean,
    raw?: unknown,
  ) {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
    this.raw = raw;
  }
}

/**
 * Whether a numeric or string code/status is considered retryable.
 * Strings are coerced via Number(); non-numeric strings are not retryable.
 */
export function isRetryable(statusOrCode: number | string): boolean {
  const n = typeof statusOrCode === "string" ? Number(statusOrCode) : statusOrCode;
  if (!Number.isFinite(n)) return false;
  return RETRYABLE_CODES.has(n);
}

/**
 * Maps a known business code to a human label and its retryability.
 * Unknown codes still return retryability via isRetryable so the pool can
 * decide without hard-coding every future code.
 */
export function mapBusinessCode(code: number | string): {
  code: number | string;
  retryable: boolean;
  message: string;
} {
  const n = typeof code === "string" ? Number(code) : code;
  let message: string;
  switch (n) {
    case 11101:
      message = "missing-system";
      break;
    case 11128:
      message = "moderation";
      break;
    case 11140:
      message = "banned";
      break;
    case 14018:
      message = "quota";
      break;
    default:
      message = `upstream code ${String(code)}`;
      break;
  }
  return { code, retryable: isRetryable(code), message };
}

/**
 * Slim classifier: given either an HTTP status or a business code from a
 * 200-envelope (`{code, msg}`), return its retryability and normalized code.
 * This is the single decision point callers use before choosing to refresh
 * vs rotate credentials.
 */
export function classify(
  statusOrCode: number | string,
): { code: number | string; retryable: boolean } {
  return { code: statusOrCode, retryable: isRetryable(statusOrCode) };
}

/** Alias kept for callers that prefer a verb-named import. */
export const classifyError = classify;

/** Back-compat alias for older import name. */
export const isRetryableCode = isRetryable;
