/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RefreshService } from "../src/credentials/refresh";
import type { Credential } from "../src/credentials/types";
import type { Config } from "../src/config";
import type { Logger } from "pino";
import { UpstreamError } from "../src/upstream/errors";
// minimal logger stub — pino interface subset used by RefreshService
function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => makeLogger(),
  } as unknown as Logger;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: "127.0.0.1",
    logLevel: "silent",
    apiBase: "https://api.example.com",
    consoleBase: "https://console.example.com",
    dbPath: ":memory:",
    upstreamTimeoutMs: 2000,
    ...overrides,
  } as Config;
}

function makeCred(opts: {
  uid?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  accessToken?: string;
  refreshToken?: string;
  domain?: string;
  apiBase?: string;
  consoleBase?: string;
  enterpriseId?: string;
}): Credential {
  const now = Date.now();
  return {
    uid: opts.uid ?? "uid-test-123",
    domain: opts.domain ?? "www.codebuddy.cn",
    apiBase: opts.apiBase ?? "https://api.example.com",
    consoleBase: opts.consoleBase ?? "https://console.example.com",
    enterpriseId: opts.enterpriseId,
    auth: {
      accessToken: opts.accessToken ?? "old-access-token",
      refreshToken: opts.refreshToken ?? "old-refresh-token",
      tokenType: "Bearer",
      expiresAt: opts.expiresAt ?? now + 60 * 60 * 1000,
      refreshExpiresAt: opts.refreshExpiresAt ?? now + 90 * 24 * 60 * 60 * 1000,
      capturedAt: now - 1000,
      source: "device-flow",
    },
  };
}

type FetchCall = { url: string; init?: RequestInit; headers: Record<string, string> };

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v as string;
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = String(v);
  return out;
}

describe("RefreshService", () => {
  let origNow: () => number;

  beforeEach(() => {
    origNow = Date.now;
  });
  afterEach(() => {
    Date.now = origNow;
  });

  it("ensureFresh skips refresh when credential is fresh", async () => {
    const cred = makeCred({ expiresAt: Date.now() + 60 * 60 * 1000 });
    const store = {
      data: cred,
      get: async () => store.data,
      upsert: async (c: Credential) => { store.data = c; },
    };
    let fetchCalls = 0;
    const fetcher = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    const out = await svc.ensureFresh(cred.uid);
    expect(out).toBe(cred);
    expect(fetchCalls).toBe(0);
  });

  it("triggers refresh when expiring (within 5min skew)", async () => {
    const expiring = makeCred({ expiresAt: Date.now() + 60 * 1000 });
    const storeData: { cred: Credential } = { cred: expiring };
    const store = {
      get: async (uid: string) => (uid === expiring.uid ? storeData.cred : null),
      upsert: async (c: Credential) => { storeData.cred = c; },
    };
    const newAT = "new-access-token-xyz";
    let refreshHeaders: Record<string, string> = {};
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        refreshHeaders = headersToRecord(init?.headers);
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              accessToken: newAT,
              refreshToken: "new-refresh-token",
              expiresAt: Date.now() + 3600 * 1000,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/console/accounts")) {
        return new Response(JSON.stringify({ code: 0, data: { uid: expiring.uid } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    const out = await svc.ensureFresh(expiring.uid);
    expect(out.auth.accessToken).toBe(newAT);
    // persistence
    expect(storeData.cred.auth.accessToken).toBe(newAT);
  });

  it("single-flight deduplication: two concurrent ensureFresh -> exactly one refresh fetch", async () => {
    const expiring = makeCred({ expiresAt: Date.now() + 1000 });
    let stored = expiring;
    const store = {
      get: async () => stored,
      upsert: async (c: Credential) => { stored = c; },
    };
    let refreshCount = 0;
    let accountsCount = 0;
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        refreshCount++;
        // delay to ensure concurrency overlap
        await new Promise((r) => setTimeout(r, 60));
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              accessToken: "deduped-token",
              refreshToken: "deduped-rt",
              expiresAt: Date.now() + 3600 * 1000,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/console/accounts")) {
        accountsCount++;
        return new Response(JSON.stringify({ data: { uid: expiring.uid } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    const [a, b] = await Promise.all([svc.ensureFresh(expiring.uid), svc.ensureFresh(expiring.uid)]);
    expect(a.auth.accessToken).toBe("deduped-token");
    expect(b.auth.accessToken).toBe("deduped-token");
    expect(refreshCount).toBe(1);
    expect(accountsCount).toBe(1);
  });

  it("preserves old refreshToken when new one absent (rotation)", async () => {
    const cred = makeCred({ expiresAt: Date.now() + 1000, refreshToken: "old-rt-keep" });
    let stored = cred;
    const store = {
      get: async () => stored,
      upsert: async (c: Credential) => { stored = c; },
    };
    const fetcher = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              accessToken: "new-at-no-rt",
              // no refreshToken
              expiresAt: Date.now() + 3600 * 1000,
            },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/console/accounts")) {
        return new Response(JSON.stringify({ data: { uid: cred.uid } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    const out = await svc.refreshNow(cred.uid);
    expect(out.auth.refreshToken).toBe("old-rt-keep");
    expect(out.auth.accessToken).toBe("new-at-no-rt");
  });

  it("throws OAUTH_TOKEN_ACCOUNT_MISMATCH on bound-uid mismatch", async () => {
    const cred = makeCred({ uid: "uid-111", expiresAt: Date.now() + 1000 });
    const store = {
      get: async () => cred,
      upsert: async () => {},
    };
    const fetcher = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "new-at", expiresAt: Date.now() + 3600 * 1000 } }), {
          status: 200,
        });
      }
      if (u.includes("/console/accounts")) {
        return new Response(JSON.stringify({ code: 0, data: { uid: "different-uid-999", accounts: [{ uid: "different-uid-999" }] } }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    await expect(svc.refreshNow(cred.uid)).rejects.toMatchObject({
      code: "OAUTH_TOKEN_ACCOUNT_MISMATCH",
    } as any);
    // also check it's an UpstreamError
    try {
      await svc.refreshNow(cred.uid);
    } catch (e) {
      expect(e).toBeInstanceOf(UpstreamError);
    }
  });

  it("network failure still cleans inflight so next call retries", async () => {
    const cred = makeCred({ expiresAt: Date.now() + 1000 });
    const store = {
      get: async () => cred,
      upsert: async () => {},
    };
    let call = 0;
    const fetcher = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        call++;
        throw new TypeError("network down");
      }
      return new Response(JSON.stringify({ data: { uid: cred.uid } }), { status: 200 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    await expect(svc.refreshNow(cred.uid)).rejects.toThrow();
    // refresh tries apiBase then consoleBase on network failure -> 2 fetch attempts per logical refresh
    expect(call).toBe(2);
    // second attempt should also call fetch (inflight cleaned)
    await expect(svc.refreshNow(cred.uid)).rejects.toThrow();
    expect(call).toBe(4);
    // also verify inflight map is empty by doing a successful third call
    let thirdCalled = 0;
    const fetcher2 = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        thirdCalled++;
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "recovered", expiresAt: Date.now() + 3600 * 1000 } }), {
          status: 200,
        });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: cred.uid } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    // reuse same service but with new fetcher — inflight should be empty, so after swapping fetcher it should work
    (svc as any).fetcher = fetcher2;
    const out = await svc.refreshNow(cred.uid);
    expect(out.auth.accessToken).toBe("recovered");
    expect(thirdCalled).toBe(1);
  });

  it("envelope handling covers both abs(ms) and rel(seconds) expiry forms", async () => {
    // abs form: expiresAt is ms epoch (>1e11)
    const now = Date.now();
    const credAbs = makeCred({ uid: "uid-abs", expiresAt: now + 1000 });
    let storedAbs = credAbs;
    const absExpiresAt = now + 7200 * 1000; // 2h later, absolute ms
    const storeAbs = {
      get: async () => storedAbs,
      upsert: async (c: Credential) => { storedAbs = c; },
    };
    const fetcherAbs = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "at-abs", expiresAt: absExpiresAt } }), { status: 200 });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: "uid-abs" } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svcAbs = new RefreshService(storeAbs as any, makeConfig(), makeLogger(), fetcherAbs as any);
    const outAbs = await svcAbs.refreshNow("uid-abs");
    expect(outAbs.auth.expiresAt).toBe(absExpiresAt);

    // rel form: expiresIn is seconds (<1e11)
    const credRel = makeCred({ uid: "uid-rel", expiresAt: now + 1000 });
    let storedRel = credRel;
    const storeRel = {
      get: async () => storedRel,
      upsert: async (c: Credential) => { storedRel = c; },
    };
    const fetcherRel = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "at-rel", expiresIn: 3600 } }), { status: 200 });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: "uid-rel" } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svcRel = new RefreshService(storeRel as any, makeConfig(), makeLogger(), fetcherRel as any);
    const before = Date.now();
    const outRel = await svcRel.refreshNow("uid-rel");
    const after = Date.now();
    // should be approximately before + 3600*1000
    expect(outRel.auth.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
    expect(outRel.auth.expiresAt).toBeLessThanOrEqual(after + 3600 * 1000 + 1000);

    // also test snake_case and refreshExpiresIn
    const credSnake = makeCred({ uid: "uid-snake", expiresAt: now + 1000 });
    let storedSnake = credSnake;
    const storeSnake = {
      get: async () => storedSnake,
      upsert: async (c: Credential) => { storedSnake = c; },
    };
    const fetcherSnake = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { access_token: "at-snake", expires_in: 1800, refresh_expires_in: 7200 },
          }),
          { status: 200 },
        );
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: "uid-snake" } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svcSnake = new RefreshService(storeSnake as any, makeConfig(), makeLogger(), fetcherSnake as any);
    const outSnake = await svcSnake.refreshNow("uid-snake");
    expect(outSnake.auth.accessToken).toBe("at-snake");
    // expiresAt approx 1800s from now
    expect(outSnake.auth.expiresAt).toBeGreaterThan(Date.now() - 2000);
  });

  it("refresh headers include required names", async () => {
    const cred = makeCred({
      uid: "uid-hdr",
      domain: "www.codebuddy.cn",
      enterpriseId: "ent-123",
      accessToken: "old-at-hdr",
      refreshToken: "old-rt-hdr",
      expiresAt: Date.now() + 1000,
    });
    let capturedHeaders: Record<string, string> | null = null;
    const store = {
      get: async () => cred,
      upsert: async () => {},
    };
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        capturedHeaders = headersToRecord(init?.headers);
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "new-at-hdr", expiresAt: Date.now() + 3600 * 1000 } }), {
          status: 200,
        });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: "uid-hdr" } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    await svc.refreshNow(cred.uid);
    expect(capturedHeaders).not.toBeNull();
    const h = capturedHeaders!;
    expect(h["authorization"]).toBe("Bearer old-at-hdr");
    expect(h["x-refresh-token"]).toBe("old-rt-hdr");
    expect(h["x-auth-refresh-source"]).toBe("plugin");
    expect(h["x-product"]).toBe("SaaS");
    expect(h["x-domain"]).toBe("www.codebuddy.cn");
    expect(h["x-user-id"]).toBe("uid-hdr");
    // also check fingerprint headers
    expect(h["x-client-platform"] ?? h["x-client-platform".toLowerCase()]).toBeDefined();
    expect(h["user-agent"]).toBe("CLI/unknown CodeBuddy/2.139.0");
  });

  it("ensureFresh single-flight visible via Map - inflight property exists and dedup works under ensureFresh", async () => {
    const cred = makeCred({ expiresAt: Date.now() + 1000 });
    const store = {
      get: async () => cred,
      upsert: async () => {},
    };
    let calls = 0;
    const fetcher = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        calls++;
        await new Promise((r) => setTimeout(r, 40));
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "tok", expiresAt: Date.now() + 3600 * 1000 } }), {
          status: 200,
        });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: cred.uid } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, makeConfig(), makeLogger(), fetcher as any);
    // verify Map visible
    expect((svc as any).inflight).toBeInstanceOf(Map);
    const p1 = svc.ensureFresh(cred.uid);
    const p2 = svc.ensureFresh(cred.uid);
    // allow async store.get microtasks to flush and inflight to be populated
    await new Promise((r) => setTimeout(r, 10));
    expect((svc as any).inflight.size).toBe(1);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect((svc as any).inflight.size).toBe(0);
  });

  it("handles apiBase fallback to consoleBase on network error", async () => {
    const cred = makeCred({ expiresAt: Date.now() + 1000 });
    const store = {
      get: async () => cred,
      upsert: async () => {},
    };
    const config = makeConfig({ apiBase: "https://api.example.com", consoleBase: "https://console.example.com" });
    const calls: string[] = [];
    const fetcher = async (url: string | URL | Request, _init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith("https://api.example.com/v2/plugin/auth/token/refresh")) {
        throw new TypeError("api down");
      }
      if (u.startsWith("https://console.example.com/v2/plugin/auth/token/refresh")) {
        return new Response(JSON.stringify({ code: 0, data: { accessToken: "fallback-at", expiresAt: Date.now() + 3600 * 1000 } }), {
          status: 200,
        });
      }
      if (u.includes("/console/accounts")) return new Response(JSON.stringify({ data: { uid: cred.uid } }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
    const svc = new RefreshService(store as any, config, makeLogger(), fetcher as any);
    const out = await svc.refreshNow(cred.uid);
    expect(out.auth.accessToken).toBe("fallback-at");
    expect(calls.filter((c) => c.includes("/v2/plugin/auth/token/refresh")).length).toBe(2);
  });
});
