import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteCredentialStore } from "../src/credentials/store";
import { RoundRobinPool } from "../src/pool/round-robin";
import type { Credential } from "../src/credentials/types";
import type { Logger } from "pino";
import type { RefreshService } from "../src/credentials/refresh";

function makeCredential(uid: string, overrides: Partial<Credential> = {}): Credential {
  const now = Date.now();
  const base: Credential = {
    uid,
    label: `label-${uid}`,
    domain: "www.codebuddy.cn",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `at-${uid}`,
      refreshToken: `rt-${uid}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "device-flow",
    },
  };
  return {
    ...base,
    ...overrides,
    uid,
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
  } as Credential;
}

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child() {
      return this as unknown as Logger;
    },
  } as unknown as Logger;
}

function tempDbPath(prefix = "codebuffy-pool-"): string {
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

function createStoreWithCreds(uids: string[]): { store: SqliteCredentialStore; dbPath: string } {
  const dbPath = tempDbPath();
  tempDirs.push(path.dirname(dbPath));
  const store = new SqliteCredentialStore(dbPath);
  stores.push(store);
  for (const uid of uids) {
    store.upsert(makeCredential(uid));
  }
  return { store, dbPath };
}

function stubRefresh(
  overrides: {
    ensureFresh?: (uid: string) => Promise<Credential>;
  } = {},
) {
  const calls: string[] = [];
  const stub = {
    calls,
    ensureFresh: async (uid: string) => {
      calls.push(uid);
      if (overrides.ensureFresh) return overrides.ensureFresh(uid);
      // default: return cred from store via lookup - caller must handle; we just echo a cred with that uid
      return makeCredential(uid);
    },
  };
  return stub;
}

describe("RoundRobinPool", () => {
  it("empty pool returns null", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(path.dirname(dbPath));
    const store = new SqliteCredentialStore(dbPath);
    stores.push(store);
    const refresh = stubRefresh() as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    const picked = await pool.pick();
    expect(picked).toBeNull();
    expect(pool.size()).toBe(0);
  });

  it("round-robin order cycles", async () => {
    const { store } = createStoreWithCreds(["uid-a", "uid-b", "uid-c"]);
    // Ensure deterministic order: SqliteCredentialStore.list() returns insertion order but not guaranteed sorted;
    // Sort our expectation by actual list order.
    const expectedOrder = store.list().map((c) => c.uid);
    // Create a refresh that returns the credential matching uid (by looking up store)
    const refresh = {
      calls: [] as string[],
      ensureFresh: async (uid: string) => {
        (refresh as { calls: string[] }).calls.push(uid);
        const found = store.get(uid);
        if (!found) throw new Error(`not found ${uid}`);
        return found;
      },
    } as unknown as RefreshService & { calls: string[] };

    const pool = new RoundRobinPool(store, refresh, makeLogger());

    // First cycle
    const p1 = await pool.pick();
    const p2 = await pool.pick();
    const p3 = await pool.pick();
    const p4 = await pool.pick(); // should wrap to first

    // The pool's idx increments each pick, so order should be expectedOrder[0], [1], [2], [0] ...
    expect(p1?.uid).toBe(expectedOrder[0]);
    expect(p2?.uid).toBe(expectedOrder[1]);
    expect(p3?.uid).toBe(expectedOrder[2]);
    expect(p4?.uid).toBe(expectedOrder[0]);

    // Verify ensureFresh called in order
    expect((refresh as unknown as { calls: string[] }).calls).toEqual([
      expectedOrder[0]!,
      expectedOrder[1]!,
      expectedOrder[2]!,
      expectedOrder[0]!,
    ]);
  });

  it("round-robin cycles multiple times correctly", async () => {
    const { store } = createStoreWithCreds(["x", "y"]);
    const order = store.list().map((c) => c.uid);
    const refresh = stubRefresh({
      ensureFresh: async (uid) => store.get(uid)!,
    }) as unknown as RefreshService & { calls: string[] };
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await pool.pick();
      picks.push(c!.uid);
    }
    const expected = [order[0]!, order[1]!, order[0]!, order[1]!, order[0]!, order[1]!];
    expect(picks).toEqual(expected);
  });

  it("single-flight refresh called: ensureFresh invoked once per pick", async () => {
    const { store } = createStoreWithCreds(["single"]);
    let callCount = 0;
    const refresh = {
      ensureFresh: async (uid: string) => {
        callCount++;
        return store.get(uid)!;
      },
    } as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    await pool.pick();
    expect(callCount).toBe(1);
    await pool.pick();
    expect(callCount).toBe(2);
  });

  it("failed refresh skipped to next cred", async () => {
    const logger = makeLogger();
    const warnCalls: Array<Record<string, unknown>> = [];
    (logger as unknown as { warn: (...args: unknown[]) => void }).warn = (...args: unknown[]) => {
      warnCalls.push(args[0] as Record<string, unknown>);
    };

    const dbPath2 = tempDbPath("codebuffy-pool-align-");
    tempDirs.push(path.dirname(dbPath2));
    const store2 = new SqliteCredentialStore(dbPath2);
    stores.push(store2);
    // Insert in order: bad first, then goods
    store2.upsert(makeCredential("bad-first"));
    store2.upsert(makeCredential("good-second"));
    store2.upsert(makeCredential("good-third"));
    const refresh2 = {
      ensureFresh: async (uid: string) => {
        if (uid === "bad-first") throw Object.assign(new Error("mismatch"), { code: "OAUTH_TOKEN_ACCOUNT_MISMATCH" });
        return store2.get(uid)!;
      },
    } as unknown as RefreshService;
    const pool2 = new RoundRobinPool(store2, refresh2, logger);
    const picked = await pool2.pick();
    // Should have skipped bad-first and returned good-second
    expect(picked?.uid).toBe("good-second");
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns null if all refreshes fail", async () => {
    const { store } = createStoreWithCreds(["a", "b"]);
    const refresh = {
      ensureFresh: async () => {
        throw new Error("all failed");
      },
    } as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    const picked = await pool.pick();
    expect(picked).toBeNull();
  });

  it("size() accurate", async () => {
    const dbPath = tempDbPath();
    tempDirs.push(path.dirname(dbPath));
    const store = new SqliteCredentialStore(dbPath);
    stores.push(store);
    const refresh = stubRefresh() as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    expect(pool.size()).toBe(0);
    store.upsert(makeCredential("one"));
    expect(pool.size()).toBe(1);
    store.upsert(makeCredential("two"));
    expect(pool.size()).toBe(2);
    store.delete("one");
    expect(pool.size()).toBe(1);
  });

  it("handles store.list() empty quickly and size reflects correctly", async () => {
    const { store } = createStoreWithCreds([]);
    const refresh = stubRefresh() as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    expect(await pool.pick()).toBeNull();
    expect(pool.size()).toBe(0);
    store.upsert(makeCredential("new-uid"));
    expect(pool.size()).toBe(1);
    const picked = await pool.pick();
    expect(picked?.uid).toBe("new-uid");
  });

  it("idx wraps safely without overflow (stress)", async () => {
    const { store } = createStoreWithCreds(["a", "b", "c"]);
    const refresh = stubRefresh({
      ensureFresh: async (uid) => store.get(uid)!,
    }) as unknown as RefreshService;
    const pool = new RoundRobinPool(store, refresh, makeLogger());
    // Access private idx to set near max
    (pool as unknown as { idx: number }).idx = Number.MAX_SAFE_INTEGER - 2;
    const p1 = await pool.pick();
    const p2 = await pool.pick();
    const p3 = await pool.pick();
    const p4 = await pool.pick();
    // Should still cycle correctly without throwing
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p3).not.toBeNull();
    expect(p4).not.toBeNull();
    // After wrap, idx should be small number
    expect((pool as unknown as { idx: number }).idx).toBeLessThan(10);
  });
});
