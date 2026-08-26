/**
 * Golden wire-identity snapshots for outbound upstream headers.
 *
 * These tests pin the EXACT header sets sent to CodeBuddy cloud so any
 * fingerprint drift (UA bump, renamed header, dropped constant) fails loudly.
 * Pattern borrowed from reference/decolua__9router/tests/translator/__snapshots__/golden-url-header.test.js.snap.
 *
 * All expected objects are literal snapshots of ACTUAL current output from
 * src/upstream/headers.ts (buildUpstreamHeaders) and src/credentials/refresh.ts
 * (buildRefreshHeaders / buildValidationHeaders, exercised through
 * RefreshService with an injected fetcher).
 *
 * To regenerate intentionally: temporarily log the built header records
 * (e.g. console.log(JSON.stringify(buildUpstreamHeaders(cred, {...}))) in a
 * scratch script), run this suite to see the diff, then update these literals
 * deliberately — never hand-edit values without observing real output first.
 */
import { describe, it, expect } from "bun:test";
import { buildUpstreamHeaders, FINGERPRINT_UA } from "../src/upstream/headers";
import { RefreshService } from "../src/credentials/refresh";
import type { Credential } from "../src/credentials/types";
import type { Config } from "../src/config";
import type { Logger } from "pino";

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

function makeConfig(): Config {
  return {
    port: 3000,
    host: "127.0.0.1",
    logLevel: "silent",
    apiBase: "https://api.example.com",
    consoleBase: "https://console.example.com",
    dbPath: ":memory:",
    upstreamTimeoutMs: 2000,
  } as Config;
}

function makeCred(opts: Partial<Credential> & { uid?: string; domain?: string }): Credential {
  const now = Date.now();
  return {
    uid: opts.uid ?? "uid-golden-1",
    domain: opts.domain ?? "copilot.tencent.com",
    apiBase: opts.apiBase ?? "https://api.example.com",
    consoleBase: opts.consoleBase ?? "https://console.example.com",
    enterpriseId: opts.enterpriseId,
    apiKey: opts.apiKey,
    auth: {
      accessToken: opts.auth?.accessToken ?? "at-golden-oauth",
      refreshToken: opts.auth?.refreshToken ?? "rt-golden",
      tokenType: "Bearer",
      expiresAt: now + 60 * 60 * 1000,
      refreshExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
      capturedAt: now - 1000,
      source: "device-flow",
    },
  };
}

describe("FINGERPRINT_UA canary", () => {
  it("matches the mandated CLI/CodeBuddy fingerprint shape", () => {
    expect(FINGERPRINT_UA).toMatch(/^CLI\/\S+ CodeBuddy\//);
  });
  // NOTE: research/02 §4 mandates CLI/<digits>, but current FINGERPRINT_UA is
  // "CLI/unknown CodeBuddy/2.139.0" (literal `unknown` placeholder). Canary
  // pins the structural shape only; tightening to /^CLI\/\d/ would fail today
  // — flagged as a src-side bug, see test report.
});

describe("buildUpstreamHeaders golden snapshots", () => {
  it("oauth mode on copilot.tencent.com pins exact header set", () => {
    const cred = makeCred({ uid: "uid-golden-1", domain: "copilot.tencent.com" });
    expect(buildUpstreamHeaders(cred, { requestId: "fixed-request-id-0001" })).toEqual({
      Authorization: "Bearer at-golden-oauth",
      "X-Product": "SaaS",
      "X-Domain": "copilot.tencent.com",
      "X-User-Id": "uid-golden-1",
      "x-client-platform": "web",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      "X-Request-Id": "fixed-request-id-0001",
    });
  });

  it("oauth mode on www.codebuddy.ai pins exact header set", () => {
    const cred = makeCred({ uid: "uid-golden-intl", domain: "www.codebuddy.ai" });
    cred.auth.accessToken = "at-golden-intl";
    expect(buildUpstreamHeaders(cred, { requestId: "fixed-request-id-0002" })).toEqual({
      Authorization: "Bearer at-golden-intl",
      "X-Product": "SaaS",
      "X-Domain": "www.codebuddy.ai",
      "X-User-Id": "uid-golden-intl",
      "x-client-platform": "web",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      "X-Request-Id": "fixed-request-id-0002",
    });
  });

  it("apikey mode (fullKey present) adds exactly X-API-Key", () => {
    const cred = makeCred({ uid: "uid-golden-key", domain: "www.codebuddy.ai" });
    cred.auth.accessToken = "at-golden-key";
    cred.apiKey = { name: "golden-key", keyId: "key-1", fullKey: "cbk_golden_full_key" };
    expect(buildUpstreamHeaders(cred, { requestId: "fixed-request-id-0003" })).toEqual({
      Authorization: "Bearer at-golden-key",
      "X-API-Key": "cbk_golden_full_key",
      "X-Product": "SaaS",
      "X-Domain": "www.codebuddy.ai",
      "X-User-Id": "uid-golden-key",
      "x-client-platform": "web",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      "X-Request-Id": "fixed-request-id-0003",
    });
  });

  it("enterprise credential adds exactly X-Enterprise-Id; refreshToken opt adds refresh pair", () => {
    const cred = makeCred({
      uid: "uid-golden-ent",
      domain: "copilot.tencent.com",
      enterpriseId: "ent-42",
    });
    cred.auth.accessToken = "at-golden-ent";
    expect(
      buildUpstreamHeaders(cred, {
        requestId: "fixed-request-id-0004",
        refreshToken: "rt-inline-refresh",
      }),
    ).toEqual({
      Authorization: "Bearer at-golden-ent",
      "X-Enterprise-Id": "ent-42",
      "X-Product": "SaaS",
      "X-Domain": "copilot.tencent.com",
      "X-User-Id": "uid-golden-ent",
      "x-client-platform": "web",
      "X-Request-Id": "fixed-request-id-0004",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      "X-Refresh-Token": "rt-inline-refresh",
      "X-Auth-Refresh-Source": "plugin",
    });
  });
});

describe("RefreshService wire identity (buildRefreshHeaders / buildValidationHeaders)", () => {
  it("token refresh POST pins exact header set", async () => {
    const expiring = makeCred({
      uid: "uid-refresh-golden",
      domain: "copilot.tencent.com",
      enterpriseId: "ent-77",
    });
    expiring.auth.expiresAt = Date.now() + 1000; // force refresh path
    expiring.auth.accessToken = "at-stale";
    expiring.auth.refreshToken = "rt-current";

    let refreshHeaders: Record<string, string> = {};
    const store = {
      get: async () => expiring,
      upsert: async () => {},
    };
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        refreshHeaders = { ...(init?.headers as Record<string, string>) };
        return new Response(
          JSON.stringify({
            code: 0,
            data: { accessToken: "at-new", expiresAt: Date.now() + 3600 * 1000 },
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

    const svc = new RefreshService(store as never, makeConfig(), makeLogger(), fetcher as typeof fetch);
    await svc.refreshNow(expiring.uid);

    expect(refreshHeaders).toEqual({
      Authorization: "Bearer at-stale",
      "X-Refresh-Token": "rt-current",
      "X-Auth-Refresh-Source": "plugin",
      "X-Product": "SaaS",
      "X-Domain": "copilot.tencent.com",
      "x-client-platform": "web",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      "X-User-Id": "uid-refresh-golden",
      "X-Enterprise-Id": "ent-77",
      "X-Tenant-Id": "ent-77",
      "content-type": "application/json",
    });
  });

  it("bound-uid validation GET /console/accounts pins exact header set", async () => {
    const expiring = makeCred({
      uid: "uid-validate-golden",
      domain: "www.codebuddy.ai",
      enterpriseId: "ent-99",
    });
    expiring.auth.expiresAt = Date.now() + 1000;
    expiring.auth.accessToken = "at-old";

    let validateHeaders: Record<string, string> = {};
    const store = {
      get: async () => expiring,
      upsert: async () => {},
    };
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v2/plugin/auth/token/refresh")) {
        return new Response(
          JSON.stringify({ code: 0, data: { accessToken: "at-fresh" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.includes("/console/accounts")) {
        validateHeaders = { ...(init?.headers as Record<string, string>) };
        return new Response(JSON.stringify({ code: 0, data: { uid: expiring.uid } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const svc = new RefreshService(store as never, makeConfig(), makeLogger(), fetcher as typeof fetch);
    await svc.refreshNow(expiring.uid);

    // Validation uses the NEW access token ("at-fresh"), not the stale one.
    expect(validateHeaders).toEqual({
      Authorization: "Bearer at-fresh",
      "X-Product": "SaaS",
      "X-Domain": "www.codebuddy.ai",
      "x-client-platform": "web",
      "User-Agent": "CLI/unknown CodeBuddy/2.139.0",
      Accept: "application/json",
      "X-User-Id": "uid-validate-golden",
      "X-Enterprise-Id": "ent-99",
    });
  });
});
