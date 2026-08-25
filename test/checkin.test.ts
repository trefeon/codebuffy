import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SqliteCredentialStore } from "../src/credentials/store";
import type { Credential } from "../src/credentials/types";
import { loadConfig } from "../src/config";
import type { Config } from "../src/config";
import { createLogger } from "../src/logger";
import { performCheckin } from "../src/checkin/client";
import { CheckinScheduler, CHECKIN_INTERVAL_MS, DEFAULT_JITTER_MS } from "../src/checkin/scheduler";
import { isCheckinEnabled } from "../src/checkin/types";
import { UpstreamError } from "../src/upstream/errors";

type CheckinConfig = Config & { checkinEnabled: boolean; checkinJitterMs: number };

function makeCredential(uid: string, checkinEnabled?: boolean): Credential {
  const c = {
    uid,
    domain: "www.codebuddy.cn",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 7200_000,
      capturedAt: Date.now(),
      source: "test",
    },
  } as Credential & { checkinEnabled?: boolean };
  if (checkinEnabled !== undefined) (c as unknown as Record<string, unknown>).checkinEnabled = checkinEnabled;
  return c as Credential;
}

function makeConfig(overrides: Record<string, unknown> = {}): CheckinConfig {
  const base = loadConfig({}, () => null);
  const cfg: Record<string, unknown> = { ...base, ...overrides };
  if (!("checkinEnabled" in cfg)) cfg.checkinEnabled = false;
  if (!("checkinJitterMs" in cfg)) cfg.checkinJitterMs = DEFAULT_JITTER_MS;
  if (!("apiBase" in cfg)) cfg.apiBase = "https://copilot.tencent.com";
  if (!("upstreamTimeoutMs" in cfg)) cfg.upstreamTimeoutMs = 5000;
  return cfg as unknown as CheckinConfig;
}

function makeLogger() {
  const cfg = loadConfig({}, () => null);
  return createLogger({ ...cfg, logLevel: "silent" } as Config);
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...((init.headers as Record<string, string>) ?? {}) },
    ...init,
  });
}

// ---------------------------------------------------------------------------
// isCheckinEnabled
// ---------------------------------------------------------------------------
describe("isCheckinEnabled", () => {
  it("false when global false regardless of per-cred", () => {
    const cred = makeCredential("u1", true);
    expect(isCheckinEnabled(cred, false)).toBe(false);
  });
  it("false when per-cred missing", () => {
    const cred = makeCredential("u1");
    expect(isCheckinEnabled(cred, true)).toBe(false);
  });
  it("false when per-cred false", () => {
    const cred = makeCredential("u1", false);
    expect(isCheckinEnabled(cred, true)).toBe(false);
  });
  it("true only when both global and per-cred true", () => {
    const cred = makeCredential("u1", true);
    expect(isCheckinEnabled(cred, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// performCheckin
// ---------------------------------------------------------------------------
describe("performCheckin", () => {
  it("POSTs to daily-checkin with Bearer and fingerprint headers, handles 200 claimed", async () => {
    const cred = makeCredential("u1", true);
    const config = makeConfig({ apiBase: "https://example.com" });
    const logger = makeLogger();
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedMethod = "";
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = (init?.method as string) ?? "";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return jsonResponse({ claimed: true, credits: 42 });
    };
    const res = await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    expect(res.claimed).toBe(true);
    expect(res.credits).toBe(42);
    expect(capturedUrl).toBe("https://example.com/v2/billing/meter/daily-checkin");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders.Authorization).toBe(`Bearer ${cred.auth.accessToken}`);
    expect(capturedHeaders["X-User-Id"]).toBe(cred.uid);
  });

  it("handles 409 already claimed with credits", async () => {
    const cred = makeCredential("u2", true);
    const config = makeConfig();
    const logger = makeLogger();
    const fetchFn = async () => new Response(JSON.stringify({ credits: 5 }), { status: 409, headers: { "content-type": "application/json" } });
    const res = await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    expect(res.claimed).toBe(false);
    expect(res.alreadyClaimed).toBe(true);
    expect(res.credits).toBe(5);
  });

  it("handles 409 without credits", async () => {
    const cred = makeCredential("u2", true);
    const config = makeConfig();
    const logger = makeLogger();
    const fetchFn = async () => new Response("", { status: 409 });
    const res = await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    expect(res.alreadyClaimed).toBe(true);
    expect(res.claimed).toBe(false);
  });

  it("throws UpstreamError on 401 not retryable", async () => {
    const cred = makeCredential("u3", true);
    const config = makeConfig();
    const logger = makeLogger();
    const fetchFn = async () => new Response(JSON.stringify({ code: 401, msg: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    let threw = false;
    try {
      await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    } catch (e) {
      threw = true;
      expect(e instanceof UpstreamError).toBe(true);
      expect((e as UpstreamError).httpStatus).toBe(401);
      expect((e as UpstreamError).retryable).toBe(false);
    }
    expect(threw).toBe(true);
  });

  it("handles 200 envelope code 0 with data", async () => {
    const cred = makeCredential("u4", true);
    const config = makeConfig();
    const logger = makeLogger();
    const fetchFn = async () => jsonResponse({ code: 0, data: { claimed: true, credits: 10 } });
    const res = await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    expect(res.claimed).toBe(true);
    expect(res.credits).toBe(10);
  });

  it("trims trailing slash from apiBase", async () => {
    const cred = makeCredential("u5", true);
    const config = makeConfig({ apiBase: "https://example.com///" });
    const logger = makeLogger();
    let url = "";
    const fetchFn = async (u: string | URL | Request) => {
      url = String(u);
      return jsonResponse({ claimed: true });
    };
    await performCheckin(cred, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    expect(url).toBe("https://example.com/v2/billing/meter/daily-checkin");
  });
});

// ---------------------------------------------------------------------------
// CheckinScheduler
// ---------------------------------------------------------------------------
describe("CheckinScheduler", () => {
  let store: SqliteCredentialStore;

  beforeEach(() => {
    store = new SqliteCredentialStore(":memory:");
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
  });

  it("disabled by default makes zero network calls on runOnce", async () => {
    const config = makeConfig({ checkinEnabled: false });
    const logger = makeLogger();
    store.upsert(makeCredential("u1", true));
    store.upsert(makeCredential("u2", true));
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResponse({ claimed: true });
    };
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    await scheduler.runOnce();
    expect(calls).toBe(0);
    scheduler.stop();
  });

  it("runOnce calls performCheckin only for per-cred enabled when global enabled", async () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    store.upsert(makeCredential("enabled-1", true));
    store.upsert(makeCredential("disabled-1", false));
    store.upsert(makeCredential("missing-flag"));
    store.upsert(makeCredential("enabled-2", true));

    const called: string[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      const uid = h["X-User-Id"] ?? "unknown";
      called.push(uid);
      return jsonResponse({ claimed: true, credits: 1 });
    };
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    await scheduler.runOnce();
    expect(called.sort()).toEqual(["enabled-1", "enabled-2"]);
    scheduler.stop();
  });

  it("runOnce sequential with small delay", async () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    store.upsert(makeCredential("a", true));
    store.upsert(makeCredential("b", true));
    const order: string[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      order.push(h["X-User-Id"] ?? "");
      return jsonResponse({ claimed: true });
    };
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    const start = Date.now();
    await scheduler.runOnce();
    expect(Date.now() - start >= 80).toBe(true);
    expect(order.length).toBe(2);
    scheduler.stop();
  });

  it("handles 409 and 401 without aborting remaining creds", async () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    store.upsert(makeCredential("ok1", true));
    store.upsert(makeCredential("conflict", true));
    store.upsert(makeCredential("unauth", true));
    store.upsert(makeCredential("ok2", true));

    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      const uid = h["X-User-Id"];
      if (uid === "conflict") return new Response("", { status: 409 });
      if (uid === "unauth") return new Response(JSON.stringify({ code: 401, msg: "unauth" }), { status: 401, headers: { "content-type": "application/json" } });
      return jsonResponse({ claimed: true });
    };
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    await scheduler.runOnce();
    scheduler.stop();
  });

  it("trigger single uid works isolated", async () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    store.upsert(makeCredential("target", true));
    store.upsert(makeCredential("other", true));
    let calledUid: string | null = null;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = (init?.headers as Record<string, string>) ?? {};
      calledUid = h["X-User-Id"] ?? null;
      return jsonResponse({ claimed: true, credits: 99 });
    };
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, fetchFn as unknown as typeof fetch);
    const res = await scheduler.trigger("target");
    expect(res.claimed).toBe(true);
    expect(res.credits).toBe(99);
    expect(calledUid as unknown as string).toBe("target");
    scheduler.stop();
  });

  it("trigger throws when global disabled", async () => {
    const config = makeConfig({ checkinEnabled: false });
    const logger = makeLogger();
    store.upsert(makeCredential("u1", true));
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, (async () => jsonResponse({ claimed: true })) as unknown as typeof fetch);
    let threw = false;
    try {
      await scheduler.trigger("u1");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    scheduler.stop();
  });

  it("trigger throws when credential not found", async () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger, (async () => jsonResponse({ claimed: true })) as unknown as typeof fetch);
    let threw = false;
    try {
      await scheduler.trigger("missing");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    scheduler.stop();
  });

  it("jitter bounds: computeDelay within interval ± jitter", () => {
    const config = makeConfig({ checkinEnabled: true, checkinJitterMs: 3600000 });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger);
    for (let i = 0; i < 50; i++) {
      const d = scheduler.computeDelay();
      expect(d >= CHECKIN_INTERVAL_MS - 3600000).toBe(true);
      expect(d <= CHECKIN_INTERVAL_MS + 3600000).toBe(true);
    }
    scheduler.stop();
  });

  it("jitter 0 gives exact interval", () => {
    const config = makeConfig({ checkinEnabled: true, checkinJitterMs: 0 });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger);
    expect(scheduler.computeDelay()).toBe(CHECKIN_INTERVAL_MS);
    scheduler.stop();
  });

  it("stop idempotent and disables running", () => {
    const config = makeConfig({ checkinEnabled: true });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger);
    scheduler.start();
    expect(scheduler.getStatus().running).toBe(true);
    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
    scheduler.stop();
    expect(scheduler.getStatus().running).toBe(false);
  });

  it("start no-op when global disabled", () => {
    const config = makeConfig({ checkinEnabled: false });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger);
    scheduler.start();
    expect(scheduler.getStatus().running).toBe(false);
    expect(scheduler.getStatus().enabled).toBe(false);
    scheduler.stop();
  });

  it("getStatus reflects enabled/running/jitter", () => {
    const config = makeConfig({ checkinEnabled: true, checkinJitterMs: 1234 });
    const logger = makeLogger();
    const scheduler = new CheckinScheduler(store, config as unknown as Config, logger);
    const s = scheduler.getStatus();
    expect(s.enabled).toBe(true);
    expect(s.intervalMs).toBe(CHECKIN_INTERVAL_MS);
    expect(s.jitterMs).toBe(1234);
    scheduler.stop();
  });
});
