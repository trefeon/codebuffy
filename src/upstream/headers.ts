import { randomBytes } from "node:crypto";
import {
  UPSTREAM_CLIENT_VERSION_DEFAULT,
  UPSTREAM_CLI_VERSION_DEFAULT,
} from "../config";
import type { Credential } from "../credentials/types";
import { siteForBase } from "../models/catalog";

/**
 * Fingerprint UA mandated by research/02 §4 (dsh CLI identity). Default
 * versions follow the config keys upstreamCliVersion / upstreamClientVersion;
 * operators may override via CODEBUFFY_UPSTREAM_*_VERSION env, which reaches
 * the wire through the versions param of buildUpstreamHeaders (never the
 * import-time const below — it is only the compiled-in default).
 */
export const FINGERPRINT_UA = `CLI/${UPSTREAM_CLI_VERSION_DEFAULT} CodeBuddy/${UPSTREAM_CLIENT_VERSION_DEFAULT}`;

/** Per-site IDE identity (9router codebuddy-cn.js:28-34 / codebuddy-intl.js:28-35). */
function ideIdentity(
  site: "cn" | "intl",
  cliVersion: string = UPSTREAM_CLI_VERSION_DEFAULT,
  clientVersion: string = UPSTREAM_CLIENT_VERSION_DEFAULT,
): { ua: string; ide: string } {
  return site === "intl"
    ? {
      ua: `IDE/${cliVersion} CodeBuddy/${clientVersion}`,
      ide: "IDE",
    }
  : { ua: `CLI/${cliVersion} CodeBuddy/${clientVersion}`, ide: "CLI" };
}

/** Live config versions threaded from Config (UpstreamClient/RefreshService pass these). */
export interface UpstreamVersions {
  cliVersion?: string;
  clientVersion?: string;
}

/**
 * Build the canonical upstream header set for CodeBuddy cloud.
 *
 * Required on every `/v2/chat/completions` and `/v3/config` call:
 *  - Authorization Bearer
 *  - X-API-Key when the credential carries a console API key
 *  - X-Product:SaaS, X-Domain, X-User-Id, X-Enterprise-Id (when present)
 *  - X-IDE-Type/X-IDE-Name (CLI for CN, IDE for intl), x-requested-with,
 *    x-codebuddy-request (9router-canonical browser-mimic headers)
 *  - x-client-platform:web, User-Agent (per-site fingerprint)
 *  - X-Request-Id random hex for tracing
 *
 * Secrets (accessToken, fullKey) appear only in header values — callers must
 * never log the returned record (pino redact covers authorization/X-API-Key
 * paths).
 */
export function buildUpstreamHeaders(
  credential: Credential,
  opts?: { refreshToken?: string; requestId?: string } & UpstreamVersions,
): Record<string, string> {
  const { ua, ide } = ideIdentity(
    siteForBase(credential.apiBase),
    opts?.cliVersion ?? UPSTREAM_CLI_VERSION_DEFAULT,
    opts?.clientVersion ?? UPSTREAM_CLIENT_VERSION_DEFAULT,
  );
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.auth.accessToken}`,
    "X-Product": "SaaS",
    "X-IDE-Type": ide,
    "X-IDE-Name": ide,
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    "X-Domain": credential.domain,
    "X-User-Id": credential.uid,
    "x-client-platform": "web",
    "User-Agent": ua,
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
