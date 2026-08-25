import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateMachine, CredentialState } from "../src/pool/state";
import { CacheAffinity, hashString, hashIRRequest, deriveAffinityKey } from "../src/pool/affinity";
import { CircuitBreaker } from "../src/pool/breaker";
import { RoundRobinPool } from "../src/pool/round-robin";
import { SqliteCredentialStore } from "../src/credentials/store";
import type { Credential } from "../src/credentials/types";
import type { Logger } from "pino";
import type { RefreshService } from "../src/credentials/refresh";

function makeCredential(uid: string): Credential {
  const now = Date.now();
  return {
    uid,
    domain: "example.com",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
  } as Credential;
}

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
}

function tempDbPath(prefix = "codebuffy-pool-state-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "pool.db");
}

const tempDirs: string[] = [];
const stores: SqliteCredentialStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {}
  }
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function createStoreWithCreds(uids: string[]): SqliteCredentialStore {
  const dbPath = tempDbPath();
  tempDirs.push(path.dirname(dbPath));
  const store = new SqliteCredentialStore(dbPath);
  stores.push(store);
  for (const uid of uids) store.upsert(makeCredential(uid));
  return store;
}

// ------------------------------------------------------------
// StateMachine
// ------------------------------------------------------------
describe("StateMachine", () => {
  it("defaults to Active and isAvailable true", () => {
    const sm = new StateMachine({ cooldownMs: 50, breakerThreshold: 5 });
    expect(sm.getState("unknown")).toBe(CredentialState.Active);
    expect(sm.isAvailable("unknown")).toBe(true);
  });

  it("retryable failure -> cooldown, then active after expiry", async () => {
    const sm = new StateMachine({ cooldownMs: 40, breakerThreshold: 5 });
    sm.recordFailure("uid-cool", 500);
    expect(sm.getState("uid-cool")).toBe(CredentialState.Cooldown);
    expect(sm.isAvailable("uid-cool")).toBe(false);
    const meta = sm.getMeta("uid-cool");
    expect(meta?.cooldownUntil).not.toBeNull();
    expect(meta?.failCount).toBe(1);

    await new Promise((r) => setTimeout(r, 60));
    expect(sm.isAvailable("uid-cool")).toBe(true);
    expect(sm.getState("uid-cool")).toBe(CredentialState.Active);
  });

  it("banned is sticky (11140) until recordSuccess", async () => {
    const sm = new StateMachine({ cooldownMs: 30, breakerThreshold: 5 });
    sm.recordFailure("uid-banned", 11140);
    expect(sm.getState("uid-banned")).toBe(CredentialState.Banned);
    expect(sm.isAvailable("uid-banned")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(sm.getState("uid-banned")).toBe(CredentialState.Banned);
    expect(sm.isAvailable("uid-banned")).toBe(false);
    sm.recordSuccess("uid-banned");
    expect(sm.getState("uid-banned")).toBe(CredentialState.Active);
    expect(sm.isAvailable("uid-banned")).toBe(true);
  });

  it("quota is sticky (14018) until recordSuccess", async () => {
    const sm = new StateMachine({ cooldownMs: 30 });
    sm.recordFailure("uid-quota", 14018);
    expect(sm.getState("uid-quota")).toBe(CredentialState.QuotaExhausted);
    expect(sm.isAvailable("uid-quota")).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(sm.getState("uid-quota")).toBe(CredentialState.QuotaExhausted);
    sm.recordSuccess("uid-quota");
    expect(sm.getState("uid-quota")).toBe(CredentialState.Active);
  });

  it("recordSuccess resets failCount and cooldown", () => {
    const sm = new StateMachine({ cooldownMs: 1000 });
    sm.recordFailure("uid", 500);
    sm.recordFailure("uid", 500);
    expect(sm.getMeta("uid")?.failCount).toBe(2);
    sm.recordSuccess("uid");
    const meta = sm.getMeta("uid");
    expect(meta?.failCount).toBe(0);
    expect(meta?.state).toBe(CredentialState.Active);
    expect(meta?.cooldownUntil).toBeNull();
  });

  it("toSnapshot reflects all tracked metas", () => {
    const sm = new StateMachine({ cooldownMs: 30 });
    sm.recordFailure("a", 500);
    sm.recordFailure("b", 11140);
    const snap = sm.toSnapshot();
    expect(snap["a"]?.state).toBe(CredentialState.Cooldown);
    expect(snap["b"]?.state).toBe(CredentialState.Banned);
  });

  it("threshold handling does not crash", () => {
    const sm = new StateMachine({ cooldownMs: 30, breakerThreshold: 3 });
    sm.recordFailure("t", 500);
    sm.recordFailure("t", 500);
    sm.recordFailure("t", 500);
    // After 3 failures, should be in cooldown (threshold reached)
    expect([CredentialState.Cooldown, CredentialState.Active]).toContain(sm.getState("t"));
    // Further failures capped
    sm.recordFailure("t", 500);
    expect(sm.getMeta("t")?.failCount).toBeLessThanOrEqual(3);
  });
});

// ------------------------------------------------------------
// CacheAffinity
// ------------------------------------------------------------
describe("CacheAffinity", () => {
  it("set and get", () => {
    const aff = new CacheAffinity({ ttlMs: 1000, maxSize: 10 });
    aff.set("conv-1", "uid-a");
    expect(aff.get("conv-1")).toBe("uid-a");
  });

  it("TTL expiry", async () => {
    const aff = new CacheAffinity({ ttlMs: 30, maxSize: 10 });
    aff.set("conv-ttl", "uid-x");
    expect(aff.get("conv-ttl")).toBe("uid-x");
    await new Promise((r) => setTimeout(r, 50));
    expect(aff.get("conv-ttl")).toBeNull();
  });

  it("LRU cap evicts oldest", () => {
    const aff = new CacheAffinity({ ttlMs: 1000, maxSize: 3 });
    aff.set("c1", "u1");
    aff.set("c2", "u2");
    aff.set("c3", "u3");
    expect(aff.size()).toBe(3);
    // Access c1 to make it MRU
    expect(aff.get("c1")).toBe("u1");
    // Insert c4, should evict oldest (c2, since c1 was promoted)
    aff.set("c4", "u4");
    expect(aff.size()).toBe(3);
    expect(aff.get("c2")).toBeNull();
    expect(aff.get("c1")).toBe("u1");
    expect(aff.get("c3")).toBe("u3");
    expect(aff.get("c4")).toBe("u4");
  });

  it("delete and clear", () => {
    const aff = new CacheAffinity({ ttlMs: 1000, maxSize: 10 });
    aff.set("k1", "u1");
    aff.set("k2", "u2");
    expect(aff.delete("k1")).toBe(true);
    expect(aff.get("k1")).toBeNull();
    aff.clear();
    expect(aff.size()).toBe(0);
    expect(aff.get("k2")).toBeNull();
  });

  it("hash helpers deterministic", () => {
    const h1 = hashString("hello");
    const h2 = hashString("hello");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
    const ir = { model: "m", messages: [{ role: "user" as const, content: "hi" }] } as unknown as Parameters<typeof hashIRRequest>[0];
    const ih1 = hashIRRequest(ir);
    const ih2 = hashIRRequest(ir);
    expect(ih1).toBe(ih2);
    const derived = deriveAffinityKey({ conversationId: "conv-123" });
    expect(derived).toBe(hashString("conv-123"));
    expect(deriveAffinityKey({})).toBeNull();
  });
});

// ------------------------------------------------------------
// CircuitBreaker
// ------------------------------------------------------------
describe("CircuitBreaker", () => {
  it("closed -> open after threshold", () => {
    const breaker = new CircuitBreaker({ threshold: 3, resetMs: 50 });
    const uid = "cb-1";
    expect(breaker.getState(uid)).toBe("closed");
    expect(breaker.shouldAllow(uid)).toBe(true);
    breaker.recordFailure(uid);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("closed");
    expect(breaker.shouldAllow(uid)).toBe(true);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("open");
    expect(breaker.shouldAllow(uid)).toBe(false);
  });

  it("open -> half-open after resetMs, single probe", async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetMs: 40 });
    const uid = "cb-half";
    breaker.recordFailure(uid);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("open");
    expect(breaker.shouldAllow(uid)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    // First call after expiry transitions to half-open and allows probe
    expect(breaker.shouldAllow(uid)).toBe(true);
    expect(breaker.getState(uid)).toBe("half-open");
    // Second call while probe in flight should deny
    expect(breaker.shouldAllow(uid)).toBe(false);
  });

  it("half-open success -> closed", async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetMs: 30 });
    const uid = "cb-success";
    breaker.recordFailure(uid);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("open");
    await new Promise((r) => setTimeout(r, 40));
    expect(breaker.shouldAllow(uid)).toBe(true); // probe
    breaker.recordSuccess(uid);
    expect(breaker.getState(uid)).toBe("closed");
    expect(breaker.shouldAllow(uid)).toBe(true);
    expect(breaker.getFailures(uid)).toBe(0);
  });

  it("half-open failure -> open again", async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetMs: 30 });
    const uid = "cb-fail";
    breaker.recordFailure(uid);
    breaker.recordFailure(uid);
    await new Promise((r) => setTimeout(r, 40));
    expect(breaker.shouldAllow(uid)).toBe(true);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("open");
    expect(breaker.shouldAllow(uid)).toBe(false);
  });

  it("recordSuccess closes from any state", () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetMs: 1000 });
    const uid = "cb-close";
    breaker.recordFailure(uid);
    breaker.recordFailure(uid);
    expect(breaker.getState(uid)).toBe("open");
    breaker.recordSuccess(uid);
    expect(breaker.getState(uid)).toBe("closed");
    expect(breaker.shouldAllow(uid)).toBe(true);
  });
});

// ------------------------------------------------------------
// RoundRobinPool integration
// ------------------------------------------------------------
describe("RoundRobinPool hardened", () => {
  it("prefers affinity when available", async () => {
    const store = createStoreWithCreds(["uid-a", "uid-b", "uid-c"]);
    const _order = store.list().map((c) => c.uid);
    void _order;
    // Put uid-b as second in list for determinism
    const refresh = {
      calls: [] as string[],
      ensureFresh: async (uid: string) => {
        refresh.calls.push(uid);
        return store.get(uid)!;
      },
    } as unknown as RefreshService & { calls: string[] };

    const pool = new RoundRobinPool(store, refresh as unknown as RefreshService, makeLogger(), {
      cooldownMs: 1000,
      breakerThreshold: 5,
      breakerResetMs: 1000,
      affinityTtlMs: 1000,
    });

    // Seed affinity: conv-123 -> uid-c
    pool.getAffinity().set("conv-123", "uid-c");
    const picked = await pool.pick({ conversationId: "conv-123" });
    expect(picked?.uid).toBe("uid-c");
    expect(refresh.calls[0]).toBe("uid-c");
  });

  it("skips banned/quota/cooldown/breaker-open and round-robins", async () => {
    const store = createStoreWithCreds(["good", "banned", "quota", "cooldown"]);
    const refresh = {
      ensureFresh: async (uid: string) => {
        if (uid === "banned" || uid === "quota" || uid === "cooldown") throw new Error(`should not be called ${uid}`);
        return store.get(uid)!;
      },
    } as unknown as RefreshService;

    const pool = new RoundRobinPool(store, refresh, makeLogger(), {
      cooldownMs: 5000,
      breakerThreshold: 5,
      breakerResetMs: 5000,
      affinityTtlMs: 5000,
    });

    // Mark banned, quota, cooldown
    pool.getStateMachine().recordFailure("banned", 11140);
    pool.getStateMachine().recordFailure("quota", 14018);
    pool.getStateMachine().recordFailure("cooldown", 500);
    // Also trip breaker for one uid
    const breaker = pool.getBreaker();
    for (let i = 0; i < 5; i++) breaker.recordFailure("cooldown");

    expect(pool.getState("banned")).toBe(CredentialState.Banned);
    expect(pool.getState("quota")).toBe(CredentialState.QuotaExhausted);
    expect(pool.getState("cooldown")).toBe(CredentialState.Cooldown);

    const picked = await pool.pick();
    expect(picked?.uid).toBe("good");

    // Also test affinity fallback: affinity points to banned, should skip to good
    pool.getAffinity().set("conv-fallback", "banned");
    const picked2 = await pool.pick({ conversationId: "conv-fallback" });
    expect(picked2?.uid).toBe("good");
    // After successful pick with conversationId, affinity should be updated to good
    expect(pool.getAffinity().get("conv-fallback")).toBe("good");
  });

  it("records success/failure and getStats counts by state", async () => {
    const store = createStoreWithCreds(["a", "b", "c"]);
    const list = store.list().map((c) => c.uid);
    const failUid = list[0]!;
    const refresh = {
      ensureFresh: async (uid: string) => {
        if (uid === failUid) {
          const err: unknown = Object.assign(new Error("upstream 500"), { code: 500, httpStatus: 500 });
          throw err;
        }
        return store.get(uid)!;
      },
    } as unknown as RefreshService;

    const pool = new RoundRobinPool(store, refresh, makeLogger(), {
      cooldownMs: 5000,
      breakerThreshold: 10,
      breakerResetMs: 5000,
    });

    const picked = await pool.pick();
    expect(picked).not.toBeNull();
    expect(picked?.uid).not.toBe(failUid);

    // After failure, failUid should be cooldown
    expect(pool.getState(failUid)).toBe(CredentialState.Cooldown);

    const stats = pool.getStats();
    expect(stats[CredentialState.Cooldown]).toBe(1);
    expect(stats[CredentialState.Active]).toBe(2);
    expect(stats[CredentialState.Banned]).toBe(0);
    expect(stats[CredentialState.QuotaExhausted]).toBe(0);
  });

  it("respects AbortSignal", async () => {
    const store = createStoreWithCreds(["x", "y"]);
    const refresh = {
      ensureFresh: async (uid: string) => {
        await new Promise((r) => setTimeout(r, 50));
        return store.get(uid)!;
      },
    } as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(pool.pick({ signal: controller.signal })).rejects.toThrow();
  });

  it("round-robin still cycles when hardened (backward compat)", async () => {
    const store = createStoreWithCreds(["uid-a", "uid-b", "uid-c"]);
    const expectedOrder = store.list().map((c) => c.uid);
    const refresh = {
      ensureFresh: async (uid: string) => store.get(uid)!,
    } as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh as unknown as RefreshService, makeLogger());
    const p1 = await pool.pick();
    const p2 = await pool.pick();
    const p3 = await pool.pick();
    const p4 = await pool.pick();
    expect(p1?.uid).toBe(expectedOrder[0]);
    expect(p2?.uid).toBe(expectedOrder[1]);
    expect(p3?.uid).toBe(expectedOrder[2]);
    expect(p4?.uid).toBe(expectedOrder[0]);
  });

  it("size() remains accurate with hardening", async () => {
    const store = createStoreWithCreds(["one", "two"]);
    const pool = new RoundRobinPool(store, {} as unknown as RefreshService, makeLogger());
    expect(pool.size()).toBe(2);
    store.delete("one");
    expect(pool.size()).toBe(1);
  });
});
