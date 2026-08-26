/**
 * Headless OAuth device-flow login for CodeBuddy CN/Intl.
 *
 * Wire semantics ported 1:1 from
 * reference/decolua__9router/src/lib/oauth/providers/codebuddy-cn.js:
 *   1. POST /v2/plugin/auth/state?platform=CLI  -> { state, authUrl }
 *   2. Human opens authUrl in a browser and approves
 *   3. GET  /v2/plugin/auth/token?state=<state> until code 0;
 *      business code 11217 means "authorization pending".
 *
 * Both domains use the CLI platform fingerprint (UA + platform=CLI) per the
 * CN reference provider; only the base URL / X-Domain differ for Intl.
 */
import type { Credential } from "./types";
import { normalizePoolFile } from "./types";

export type DeviceFlowDomain = "cn" | "intl";

const DOMAINS: Record<DeviceFlowDomain, { base: string; host: string }> = {
  cn: { base: "https://copilot.tencent.com", host: "copilot.tencent.com" },
  intl: { base: "https://www.codebuddy.ai", host: "www.codebuddy.ai" },
};

const DEVICE_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const PLATFORM = "CLI";
/** Upstream-recommended poll cadence surfaced to callers (seconds). */
const INTERVAL_SEC = 5;
/** Business code returned while the user has not finished browser auth. */
const PENDING_CODE = 11217;
/** Access-token TTL used when upstream omits expiresIn (per 9router mapTokens). */
const DEFAULT_EXPIRES_IN = 86400;

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceFlowStart {
  state: string;
  authUrl: string;
  intervalSec: number;
}

export interface DeviceFlowTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
}

export type DeviceFlowPoll =
  | { status: "pending" }
  | { status: "success"; tokens: DeviceFlowTokens }
  | { status: "error"; message: string };

interface Envelope {
  code?: number;
  msg?: string;
  data?: Record<string, unknown> | null;
}

function anonHeaders(host: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": DEVICE_UA,
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": host,
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    ...extra,
  };
}

/**
 * Step 1 — request a device-flow state. Throws DeviceFlowError on transport
 * or envelope failures so admin callers can surface a concrete message.
 */
export async function startDeviceFlow(
  domain: DeviceFlowDomain,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<DeviceFlowStart> {
  const f = opts.fetchImpl ?? fetch;
  const { base, host } = DOMAINS[domain];
  const res = await f(`${base}/v2/plugin/auth/state?platform=${PLATFORM}`, {
    method: "POST",
    headers: anonHeaders(host, { "Content-Type": "application/json", "X-Product": "SaaS" }),
    body: "{}",
  });
  if (!res.ok) {
    throw new DeviceFlowError(`device-flow state request failed (${res.status})`);
  }
  const json = (await res.json()) as Envelope;
  const state = typeof json.data?.state === "string" ? json.data.state : undefined;
  const authUrl = typeof json.data?.authUrl === "string" ? json.data.authUrl : undefined;
  if (json.code !== 0 || !state || !authUrl) {
    throw new DeviceFlowError(json.msg ?? "missing state/authUrl");
  }
  return { state, authUrl, intervalSec: INTERVAL_SEC };
}

/**
 * Step 3 — poll the token endpoint once. Never throws for business outcomes:
 * pending and upstream errors are modeled on DeviceFlowPoll; only an
 * unparseable body rejects.
 */
export async function pollDeviceFlow(
  domain: DeviceFlowDomain,
  state: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<DeviceFlowPoll> {
  const f = opts.fetchImpl ?? fetch;
  const { base, host } = DOMAINS[domain];
  const res = await f(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
    method: "GET",
    headers: anonHeaders(host, {
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
      "X-Product": "SaaS",
    }),
  });
  if (!res.ok) {
    return { status: "error", message: `token request failed (${res.status})` };
  }
  const json = (await res.json()) as Envelope;
  const data = json.data ?? {};
  if (json.code === 0 && typeof data.accessToken === "string" && data.accessToken) {
    return {
      status: "success",
      tokens: {
        accessToken: data.accessToken,
        refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : "",
        tokenType: typeof data.tokenType === "string" && data.tokenType ? data.tokenType : "Bearer",
        expiresIn: typeof data.expiresIn === "number" && Number.isFinite(data.expiresIn) ? data.expiresIn : DEFAULT_EXPIRES_IN,
      },
    };
  }
  if (json.code === PENDING_CODE) {
    return { status: "pending" };
  }
  return { status: "error", message: json.msg ?? "unknown_error" };
}

/**
 * Build a pool-ready Credential from a successful poll via the shared
 * normalizePoolFile factory (same path as pool-file import), so expiry math,
 * consoleBase derivation and validation stay in one place.
 *
 * uid note: the token endpoint returns no account id; without a follow-up
 * /console/accounts call the best stable key is the opaque state itself.
 * Callers may pass an explicit uid (e.g. resolved elsewhere) to override.
 */
export function credentialFromDeviceFlow(input: {
  domain: DeviceFlowDomain;
  state: string;
  tokens: DeviceFlowTokens;
  uid?: string;
}): Credential {
  const { base, host } = DOMAINS[input.domain];
  return normalizePoolFile({
    uid: input.uid ?? `device-${input.state.slice(0, 12)}`,
    label: "device-flow",
    source: "device-flow",
    domain: host,
    apiBase: base,
    auth: {
      accessToken: input.tokens.accessToken,
      refreshToken: input.tokens.refreshToken,
      tokenType: input.tokens.tokenType,
      expiresIn: input.tokens.expiresIn,
      capturedAt: Date.now(),
    },
  });
}
