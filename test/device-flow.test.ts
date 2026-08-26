import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  startDeviceFlow,
  pollDeviceFlow,
  credentialFromDeviceFlow,
  DeviceFlowError,
} from "../src/credentials/device-flow";
import { mountAdminRoutes } from "../src/admin/routes";
import { adminAuth } from "../src/middleware/admin-auth";
import { createLogger } from "../src/logger";
import { loadConfig } from "../src/config";
import type { Credential } from "../src/credentials/types";
import type { CredentialStore } from "../src/credentials/store";

// ---- fetch recorder ---------------------------------------------------------

interface FakeSpec {
  status?: number;
  json?: unknown;
}

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

/**
 * Fetch stub that records every call and replays scripted JSON envelopes
 * (last spec repeats). No network — deterministic by construction.
 */
function makeFetch(specs: FakeSpec[]) {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const spec = specs[Math.min(calls.length - 1, specs.length - 1)] ?? { json: {} };
    return new Response(JSON.stringify(spec.json ?? {}), {
      status: spec.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Identity-shaped stub: matches global fetch signature exactly.
  const fetchImpl = impl as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const CN_START_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  "X-Requested-With": "XMLHttpRequest",
  "X-Domain": "copilot.tencent.com",
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-Product": "SaaS",
};

const POLL_HEADERS_BASE: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
  "X-Requested-With": "XMLHttpRequest",
  "X-No-Authorization": "true",
  "X-No-User-Id": "true",
  "X-No-Enterprise-Id": "true",
  "X-No-Department-Info": "true",
  "X-Product": "SaaS",
};

// ---- startDeviceFlow wire fidelity -----------------------------------------

describe("startDeviceFlow", () => {
  it("posts exact wire shape for cn", async () => {
    const fake = makeFetch([{ json: { code: 0, data: { state: "S1", authUrl: "https://auth/cn" } } }]);
    const start = await startDeviceFlow("cn", { fetchImpl: fake.fetchImpl });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI");
    expect(call.method).toBe("POST");
    expect(call.body).toBe("{}");
    expect(call.headers).toEqual(CN_START_HEADERS);
    expect(start).toEqual({ state: "S1", authUrl: "https://auth/cn", intervalSec: 5 });
  });

  it("targets the intl base/host with identical fingerprint", async () => {
    const fake = makeFetch([{ json: { code: 0, data: { state: "S2", authUrl: "https://auth/intl" } } }]);
    await startDeviceFlow("intl", { fetchImpl: fake.fetchImpl });
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://www.codebuddy.ai/v2/plugin/auth/state?platform=CLI");
    expect(call.headers).toEqual({ ...CN_START_HEADERS, "X-Domain": "www.codebuddy.ai" });
  });

  it("throws DeviceFlowError on non-ok transport", async () => {
    const fake = makeFetch([{ status: 503, json: {} }]);
    expect(startDeviceFlow("cn", { fetchImpl: fake.fetchImpl })).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it("surfaces upstream msg on business error", async () => {
    const fake = makeFetch([{ json: { code: 11101, msg: "stream only" } }]);
    expect(startDeviceFlow("cn", { fetchImpl: fake.fetchImpl })).rejects.toThrow("stream only");
  });

  it("rejects envelopes missing state/authUrl", async () => {
    const fake = makeFetch([{ json: { code: 0, data: { state: "only-state" } } }]);
    expect(startDeviceFlow("cn", { fetchImpl: fake.fetchImpl })).rejects.toThrow("missing state/authUrl");
  });
});

// ---- pollDeviceFlow mapping -------------------------------------------------

describe("pollDeviceFlow", () => {
  it("GETs the encoded state with anonymous poll headers for cn", async () => {
    const fake = makeFetch([{ json: { code: 11217 } }]);
    const result = await pollDeviceFlow("cn", "st+ate/x=", { fetchImpl: fake.fetchImpl });
    const call = fake.calls[0]!;
    expect(call.url).toBe("https://copilot.tencent.com/v2/plugin/auth/token?state=st%2Bate%2Fx%3D");
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.headers).toEqual({ ...POLL_HEADERS_BASE, "X-Domain": "copilot.tencent.com" });
    expect(result).toEqual({ status: "pending" });
  });

  it("maps 11217 to pending for intl too", async () => {
    const fake = makeFetch([{ json: { code: 11217, msg: "RetryFetchToken" } }]);
    const result = await pollDeviceFlow("intl", "abc", { fetchImpl: fake.fetchImpl });
    expect(fake.calls[0]!.url).toBe("https://www.codebuddy.ai/v2/plugin/auth/token?state=abc");
    expect(fake.calls[0]!.headers).toEqual({ ...POLL_HEADERS_BASE, "X-Domain": "www.codebuddy.ai" });
    expect(result).toEqual({ status: "pending" });
  });

  it("maps success envelope to tokens with passthrough expiry", async () => {
    const fake = makeFetch([
      { json: { code: 0, data: { accessToken: "at1", refreshToken: "rt1", tokenType: "Bearer", expiresIn: 3600 } } },
    ]);
    const result = await pollDeviceFlow("cn", "s", { fetchImpl: fake.fetchImpl });
    expect(result).toEqual({
      status: "success",
      tokens: { accessToken: "at1", refreshToken: "rt1", tokenType: "Bearer", expiresIn: 3600 },
    });
  });

  it("defaults expiresIn to 86400 and tolerates missing refresh/tokenType", async () => {
    const fake = makeFetch([{ json: { code: 0, data: { accessToken: "at2" } } }]);
    const result = await pollDeviceFlow("cn", "s", { fetchImpl: fake.fetchImpl });
    expect(result).toEqual({
      status: "success",
      tokens: { accessToken: "at2", refreshToken: "", tokenType: "Bearer", expiresIn: 86400 },
    });
  });

  it("maps other business codes to error with msg", async () => {
    const fake = makeFetch([{ json: { code: 40001, msg: "state expired" } }]);
    const result = await pollDeviceFlow("cn", "s", { fetchImpl: fake.fetchImpl });
    expect(result).toEqual({ status: "error", message: "state expired" });
  });

  it("falls back to unknown_error when msg absent", async () => {
    const fake = makeFetch([{ json: { code: 7 } }]);
    const result = await pollDeviceFlow("cn", "s", { fetchImpl: fake.fetchImpl });
    expect(result).toEqual({ status: "error", message: "unknown_error" });
  });

  it("maps non-ok transport to error instead of throwing", async () => {
    const fake = makeFetch([{ status: 500, json: {} }]);
    const result = await pollDeviceFlow("cn", "s", { fetchImpl: fake.fetchImpl });
    expect(result.status).toBe("error");
    expect((result as { message: string }).message).toContain("500");
  });
});

// ---- credential factory ------------------------------------------------------

describe("credentialFromDeviceFlow", () => {
  it("builds a pool-ready credential via normalizePoolFile (cn)", () => {
    const before = Date.now();
    const cred = credentialFromDeviceFlow({
      domain: "cn",
      state: "STATE1234567890",
      tokens: { accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 7200 },
    });
    expect(cred.uid).toBe("device-STATE1234567");
    expect(cred.label).toBe("device-flow");
    expect(cred.domain).toBe("copilot.tencent.com");
    expect(cred.apiBase).toBe("https://copilot.tencent.com");
    expect(cred.consoleBase).toBe("https://copilot.tencent.com");
    expect(cred.auth.source).toBe("device-flow");
    expect(cred.auth.tokenType).toBe("Bearer");
    // expiresAt derives from expiresIn (seconds -> ms)
    expect(cred.auth.expiresAt).toBeGreaterThanOrEqual(before + 7200_000 - 1000);
    expect(cred.auth.expiresAt).toBeLessThanOrEqual(Date.now() + 7200_000 + 1000);
  });

  it("uses intl bases and honors an explicit uid override", () => {
    const cred = credentialFromDeviceFlow({
      domain: "intl",
      state: "XYZ",
      tokens: { accessToken: "a", refreshToken: "r", tokenType: "Bearer", expiresIn: 60 },
      uid: "user-42",
    });
    expect(cred.uid).toBe("user-42");
    expect(cred.domain).toBe("www.codebuddy.ai");
    expect(cred.apiBase).toBe("https://www.codebuddy.ai");
    expect(cred.consoleBase).toBe("https://www.codebuddy.ai");
  });

  it("refuses to persist without a refresh token", () => {
    expect(() =>
      credentialFromDeviceFlow({
        domain: "cn",
        state: "S",
        tokens: { accessToken: "a", refreshToken: "", tokenType: "Bearer", expiresIn: 60 },
      }),
    ).toThrow(/refreshToken/i);
  });
});

// ---- admin routes ------------------------------------------------------------

function makeMemoryStore(): CredentialStore & { _map: Map<string, Credential> } {
  const map = new Map<string, Credential>();
  return {
    _map: map,
    upsert(cred: Credential) {
      map.set(cred.uid, cred);
    },
    get(uid: string) {
      return map.get(uid) ?? null;
    },
    list() {
      return [...map.values()];
    },
    delete(uid: string) {
      map.delete(uid);
    },
    close() {},
  };
}

function buildApp(opts: { store: CredentialStore | null; specs: FakeSpec[] }) {
  const baseConfig = loadConfig({}, () => null);
  const config = { ...baseConfig, logLevel: "silent" as const };
  const logger = createLogger(config);
  const fake = makeFetch(opts.specs);
  const app = new Hono();
  app.use("/admin/*", adminAuth(config)); // no keys configured -> open mode
  mountAdminRoutes(app, {
    config,
    logger,
    store: opts.store,
    fetchImpl: fake.fetchImpl,
  });
  return { app, fake };
}

describe("POST /admin/credentials/device-flow/*", () => {
  it("start returns state/authUrl and hits the cn wire endpoint", async () => {
    const { app, fake } = buildApp({
      store: makeMemoryStore(),
      specs: [{ json: { code: 0, data: { state: "ST-1", authUrl: "https://auth.example/login" } } }],
    });
    const res = await app.request("/admin/credentials/device-flow/start", {
      method: "POST",
      body: JSON.stringify({ domain: "cn" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.state).toBe("ST-1");
    expect(body.authUrl).toBe("https://auth.example/login");
    expect(body.intervalSec).toBe(5);
    expect(fake.calls[0]!.method).toBe("POST");
  });

  it("start rejects unknown domains with 400", async () => {
    const { app } = buildApp({ store: makeMemoryStore(), specs: [] });
    const res = await app.request("/admin/credentials/device-flow/start", {
      method: "POST",
      body: JSON.stringify({ domain: "jp" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_DOMAIN");
  });

  it("start maps upstream failures to 502", async () => {
    const { app } = buildApp({ store: makeMemoryStore(), specs: [{ status: 503, json: {} }] });
    const res = await app.request("/admin/credentials/device-flow/start", {
      method: "POST",
      body: JSON.stringify({ domain: "cn" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DEVICE_FLOW_FAILED");
  });

  it("pending poll answers 200 with status pending", async () => {
    const { app } = buildApp({ store: makeMemoryStore(), specs: [{ json: { code: 11217 } }] });
    const res = await app.request("/admin/credentials/device-flow/poll", {
      method: "POST",
      body: JSON.stringify({ domain: "cn", state: "ST-1" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(body.intervalSec).toBe(5);
  });

  it("successful poll persists a sanitized credential into the store", async () => {
    const store = makeMemoryStore();
    const { app } = buildApp({
      store,
      specs: [
        { json: { code: 0, data: { accessToken: "AT-1", refreshToken: "RT-1", expiresIn: 1800 } } },
      ],
    });
    const res = await app.request("/admin/credentials/device-flow/poll", {
      method: "POST",
      body: JSON.stringify({ domain: "intl", state: "STATEABCD1234", uid: "acct-77" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; credential: Record<string, unknown> };
    expect(body.status).toBe("success");
    // sanitized — never leak tokens over the admin API
    expect(body.credential.uid).toBe("acct-77");
    expect(JSON.stringify(body.credential)).not.toContain("AT-1");

    const stored = store.get("acct-77")!;
    expect(stored).toBeDefined();
    expect(stored.auth.source).toBe("device-flow");
    expect(stored.auth.accessToken).toBe("AT-1");
    expect(stored.auth.refreshToken).toBe("RT-1");
    expect(stored.apiBase).toBe("https://www.codebuddy.ai");
    expect(stored.domain).toBe("www.codebuddy.ai");
    expect(stored.auth.expiresAt).toBeGreaterThan(Date.now());
  });

  it("poll without state is 400", async () => {
    const { app } = buildApp({ store: makeMemoryStore(), specs: [] });
    const res = await app.request("/admin/credentials/device-flow/poll", {
      method: "POST",
      body: JSON.stringify({ domain: "cn" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STATE");
  });

  it("upstream business errors surface as 502 DEVICE_FLOW_ERROR", async () => {
    const { app } = buildApp({ store: makeMemoryStore(), specs: [{ json: { code: 40001, msg: "expired" } }] });
    const res = await app.request("/admin/credentials/device-flow/poll", {
      method: "POST",
      body: JSON.stringify({ domain: "cn", state: "S" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DEVICE_FLOW_ERROR");
    expect(body.error.message).toBe("expired");
  });

  it("poll without a configured store is 503", async () => {
    const { app } = buildApp({ store: null, specs: [{ json: { code: 0, data: { accessToken: "a" } } }] });
    const res = await app.request("/admin/credentials/device-flow/poll", {
      method: "POST",
      body: JSON.stringify({ domain: "cn", state: "S" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
  });
});
