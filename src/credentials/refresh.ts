import type { Config } from "../config";
import type { Logger } from "../logger";
import type { Credential } from "./types";
import { isExpiring } from "./types";
import { UpstreamError, RETRYABLE_CODES } from "../upstream/errors";

const FINGERPRINT_UA = "CLI/unknown CodeBuddy/2.137.1";

export interface RefreshStore {
  get(uid: string): Promise<Credential | null> | Credential | null;
  upsert(cred: Credential): Promise<void> | void;
}

type Fetcher = typeof fetch;

interface RefreshEnvelope {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
}

function toMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return undefined;
  if (n < 1e11) {
    // relative seconds offset (or seconds-epoch <1e11) -> convert to absolute ms
    // For n >= 1e9 it's seconds epoch; for small n it's relative seconds.
    // Both cases are handled by spec as "rel <1e11 => seconds".
    // Distinguish: n >= 1e9 is far future if treated as relative (would be year 2060+), but spec says rel is seconds, abs is ms.
    // Simpler: if n < 1e11 treat as seconds from now.
    return Date.now() + n * 1000;
  }
  return n;
}

function pickRefreshData(data: Record<string, unknown>): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
} {
  const accessToken =
    (data.accessToken as string | undefined) ??
    (data.access_token as string | undefined) ??
    (data.token as string | undefined);
  if (!accessToken) throw new Error("refresh envelope missing accessToken");

  const refreshToken =
    (data.refreshToken as string | undefined) ??
    (data.refresh_token as string | undefined) ??
    (data.refreshTokenNew as string | undefined) ??
    undefined;

  // expiry may be absolute ms or relative seconds; try both field spellings
  const rawExpiresAt =
    data.expiresAt ??
    data.expires_at ??
    (data as Record<string, unknown>).expireAt ??
    undefined;
  const rawExpiresIn =
    data.expiresIn ??
    data.expires_in ??
    (data as Record<string, unknown>).expires_in_seconds ??
    undefined;

  const rawRefreshExpiresAt =
    data.refreshExpiresAt ??
    data.refresh_expires_at ??
    (data as Record<string, unknown>).refreshExpires_at ??
    undefined;
  const rawRefreshExpiresIn =
    data.refreshExpiresIn ??
    data.refresh_expires_in ??
    undefined;

  let expiresAt: number | undefined;
  if (rawExpiresAt !== undefined) expiresAt = toMs(rawExpiresAt);
  if (expiresAt === undefined && rawExpiresIn !== undefined) expiresAt = toMs(rawExpiresIn);

  let refreshExpiresAt: number | undefined;
  if (rawRefreshExpiresAt !== undefined) refreshExpiresAt = toMs(rawRefreshExpiresAt);
  if (refreshExpiresAt === undefined && rawRefreshExpiresIn !== undefined)
    refreshExpiresAt = toMs(rawRefreshExpiresIn);

  return { accessToken, refreshToken, expiresAt, refreshExpiresAt };
}

function findUid(payload: unknown, depth = 0): string | undefined {
  if (depth > 6 || payload === null || payload === undefined) return undefined;
  if (typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  // direct keys
  for (const key of ["uid", "userId", "user_id", "sub", "id"]) {
    const hit = Object.entries(obj).find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (hit) {
      const val = hit[1];
      if (typeof val === "string" && val.length > 0) return val;
      if (typeof val === "number" && Number.isFinite(val)) return String(val);
    }
  }
  // search nested values
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findUid(v, depth + 1);
      if (found) return found;
    }
    // also handle arrays
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = findUid(item, depth + 1);
        if (found) return found;
      }
    }
  }
  return undefined;
}

// Search payload for expected uid at any depth — used for bound-uid check.
// Returns true if expected uid is present anywhere in payload.
function containsUid(payload: unknown, expectedUid: string, depth = 0): boolean {
  if (depth > 8 || payload === null || payload === undefined) return false;
  if (typeof payload === "string") return payload === expectedUid;
  if (typeof payload !== "object") return false;
  if (Array.isArray(payload)) {
    for (const item of payload) if (containsUid(item, expectedUid, depth + 1)) return true;
    return false;
  }
  const obj = payload as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v === expectedUid) {
      // ensure key is uid-like to avoid false positives on unrelated strings
      const lk = k.toLowerCase();
      if (lk.includes("uid") || lk === "id" || lk === "sub" || lk.includes("userid") || lk.includes("user_id")) return true;
    }
    if (v && typeof v === "object" && containsUid(v, expectedUid, depth + 1)) return true;
  }
  // fallback: deep findUid check
  const found = findUid(payload, depth);
  return found === expectedUid;
}

function buildRefreshHeaders(cred: Credential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.auth.accessToken}`,
    "X-Refresh-Token": cred.auth.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    "X-Product": "SaaS",
    "X-Domain": cred.domain,
    "x-client-platform": "web",
    "User-Agent": FINGERPRINT_UA,
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  if (cred.enterpriseId) headers["X-Enterprise-Id"] = cred.enterpriseId;
  // speculative: include tenant variant for compatibility
  if (cred.enterpriseId) headers["X-Tenant-Id"] = cred.enterpriseId;
  return headers;
}

function buildValidationHeaders(uid: string, accessToken: string, domain: string, enterpriseId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "X-Product": "SaaS",
    "X-Domain": domain,
    "x-client-platform": "web",
    "User-Agent": FINGERPRINT_UA,
    Accept: "application/json",
  };
  if (uid) headers["X-User-Id"] = uid;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  return headers;
}

export class RefreshService {
  private inflight = new Map<string, Promise<Credential>>();

  constructor(
    private store: RefreshStore,
    private config: Config,
    private logger: Logger,
    private fetcher: Fetcher = globalThis.fetch,
  ) {}

  private isExpiring(cred: Credential): boolean {
    return isExpiring(cred, 5 * 60 * 1000);
  }

  async ensureFresh(uid: string): Promise<Credential> {
    const cred = await this.store.get(uid);
    if (!cred) throw new UpstreamError("CREDENTIAL_NOT_FOUND", `credential not found: ${uid}`, 404, false);
    if (!this.isExpiring(cred)) return cred;
    return this.refreshNow(uid);
  }

  async refreshNow(uid: string): Promise<Credential> {
    const inflight = this.inflight.get(uid);
    if (inflight) return inflight;

    const p = (async (): Promise<Credential> => {
      try {
        const cred = await this.store.get(uid);
        if (!cred) throw new UpstreamError("CREDENTIAL_NOT_FOUND", `credential not found: ${uid}`, 404, false);

        this.logger.info({ uid }, "refreshing credential");

        const updatedData = await this.doRefresh(cred);

        // bound-uid validation before persisting
        await this.validateBoundUid(updatedData.accessToken, cred, uid);

        const updated: Credential = {
          ...cred,
          auth: {
            ...cred.auth,
            accessToken: updatedData.accessToken,
            refreshToken: updatedData.refreshToken ?? cred.auth.refreshToken,
            expiresAt: updatedData.expiresAt ?? cred.auth.expiresAt,
            refreshExpiresAt: updatedData.refreshExpiresAt ?? cred.auth.refreshExpiresAt,
            capturedAt: Date.now(),
          },
        };

        await this.store.upsert(updated);
        this.logger.info({ uid }, "credential refreshed");
        return updated;
      } finally {
        this.inflight.delete(uid);
      }
    })();

    this.inflight.set(uid, p);
    return p;
  }

  private async doRefresh(cred: Credential): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    refreshExpiresAt?: number;
  }> {
    const headers = buildRefreshHeaders(cred);
    const body = JSON.stringify({});

    const bases = [this.config.apiBase, this.config.consoleBase];
    let lastError: unknown = null;

    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      if (!base) continue;
      const url = `${base.replace(/\/$/, "")}/v2/plugin/auth/token/refresh`;
      const isLast = i === bases.length - 1;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
        let res: Response;
        try {
          res = await this.fetcher(url, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        const text = await res.text();
        let json: RefreshEnvelope | null = null;
        try {
          json = text ? (JSON.parse(text) as RefreshEnvelope) : null;
        } catch {
          // non-JSON body
        }

        if (!res.ok) {
          const code = json?.code ?? res.status;
          const msg = json?.msg ?? `refresh failed with HTTP ${res.status}`;
          const retryable = RETRYABLE_CODES.has(code) || RETRYABLE_CODES.has(res.status) || res.status >= 500;
          throw new UpstreamError(code, msg, res.status, retryable, json ?? text);
        }

        if (!json) {
          throw new UpstreamError(res.status, `refresh returned empty body`, res.status, false, text);
        }

        if (typeof json.code === "number" && json.code !== 0) {
          const retryable = RETRYABLE_CODES.has(json.code) || RETRYABLE_CODES.has(res.status);
          throw new UpstreamError(json.code, json.msg ?? `refresh business error ${json.code}`, res.status, retryable, json);
        }

        const data = json.data;
        if (!data || typeof data !== "object") {
          throw new UpstreamError("REFRESH_INVALID_ENVELOPE", "refresh envelope missing data", res.status, false, json);
        }

        const picked = pickRefreshData(data as Record<string, unknown>);
        return picked;
      } catch (err) {
        lastError = err;
        // If UpstreamError and it's not a network-level failure, don't fallback — surface immediately
        // Network failures: TypeError, AbortError, or UpstreamError with 5xx / non-ok that may be host-specific.
        // Spec: try apiBase first -> fallback on network failure. Keep fallback narrow.
        if (err instanceof UpstreamError) {
          // 5xx or 429 could be host-specific, allow fallback; business codes like 11140 etc should also not fallback if from business envelope?
          // But to respect "try apiBase first" literally, fallback only when first attempt threw due to network/abort or HTTP 5xx from that host.
          // If it's a business envelope error (code !==0 but http 200) we should not fallback — it's an upstream logical error.
          const isBusiness = typeof err.code === "number" && err.code !== err.httpStatus;
          if (isBusiness) throw err;
          if (err.httpStatus >= 500 || err.httpStatus === 429) {
            if (!isLast) continue;
          }
          throw err;
        }
        // Network error (TypeError, DOMException AbortError, etc.) -> fallback to next base if not last
        if (!isLast) continue;
        throw err;
      }
    }
    throw lastError ?? new UpstreamError("REFRESH_FAILED", "refresh failed: no base attempted", 500, true);
  }

  private async validateBoundUid(newAccessToken: string, originalCred: Credential, expectedUid: string): Promise<void> {
    const url = `${this.config.consoleBase.replace(/\/$/, "")}/console/accounts`;
    const headers = buildValidationHeaders(expectedUid, newAccessToken, originalCred.domain, originalCred.enterpriseId);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.upstreamTimeoutMs);
    let res: Response;
    try {
      res = await this.fetcher(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }

    if (!res.ok) {
      throw new UpstreamError(
        res.status,
        `bound-uid validation failed with HTTP ${res.status}`,
        res.status,
        RETRYABLE_CODES.has(res.status),
        json ?? text,
      );
    }

    // Try to locate expected uid in response. Payload may be envelope {code, data} or direct.
    let payload: unknown = json;
    if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
      const data = (json as Record<string, unknown>).data;
      payload = data ?? json;
    }

    const ok = containsUid(payload, expectedUid) || containsUid(json, expectedUid);
    if (!ok) {
      // Also try findUid equality — if found uid differs from expected, it's mismatch
      const found = findUid(payload) ?? findUid(json);
      if (found !== expectedUid) {
        throw new UpstreamError("OAUTH_TOKEN_ACCOUNT_MISMATCH", `bound uid mismatch: expected ${expectedUid} but got ${found ?? "unknown"}`, 401, false, json);
      }
    }
  }
}
