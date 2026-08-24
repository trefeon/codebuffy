import { randomBytes } from "node:crypto";
import type { Credential } from "../credentials/types";

/** Fingerprint UA mandated by research/02 §4 (dsh CLI identity). */
export const FINGERPRINT_UA = "CLI/unknown CodeBuddy/2.137.1";

/**
 * Build the canonical upstream header set for CodeBuddy cloud.
 *
 * Required on every `/v2/chat/completions` and `/v3/config` call:
 *  - Authorization Bearer
 *  - X-API-Key when the credential carries a console API key
 *  - X-Product:SaaS, X-Domain, X-User-Id, X-Enterprise-Id (when present)
 *  - x-client-platform:web, User-Agent (fingerprint)
 *  - X-Request-Id random hex for tracing
 *
 * Secrets (accessToken, fullKey) appear only in header values — callers must
 * never log the returned record (pino redact covers authorization/X-API-Key
 * paths).
 */
export function buildUpstreamHeaders(
  credential: Credential,
  opts?: { refreshToken?: string; requestId?: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.auth.accessToken}`,
    "X-Product": "SaaS",
    "X-Domain": credential.domain,
    "X-User-Id": credential.uid,
    "x-client-platform": "web",
    "User-Agent": FINGERPRINT_UA,
    "X-Request-Id": opts?.requestId ?? randomBytes(16).toString("hex"),
  };

  if (credential.apiKey?.fullKey) {
    headers["X-API-Key"] = credential.apiKey.fullKey;
  }

  if (credential.enterpriseId) {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }

  if (opts?.refreshToken) {
    headers["X-Refresh-Token"] = opts.refreshToken;
    headers["X-Auth-Refresh-Source"] = "plugin";
  }

  return headers;
}
