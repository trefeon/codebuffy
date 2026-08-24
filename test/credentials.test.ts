import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { normalizePoolFile, isExpiring } from "../src/credentials/types";
import type { Credential } from "../src/credentials/types";
import { SqliteCredentialStore } from "../src/credentials/store";
import { importPoolDir } from "../src/credentials/file-importer";

// helpers -------------------------------------------------------------------

function makeCredential(overrides: Partial<Credential> & { uid: string }): Credential {
  const now = Date.now();
  return {
    uid: overrides.uid,
    label: overrides.label ?? "test-label",
    domain: overrides.domain ?? "www.codebuddy.cn",
    apiBase: overrides.apiBase ?? "https://copilot.tencent.com",
    consoleBase: overrides.consoleBase ?? "https://www.codebuddy.cn",
    enterpriseId: overrides.enterpriseId,
    nickname: overrides.nickname,
    auth: overrides.auth ?? {
      accessToken: `at-${overrides.uid}`,
      refreshToken: `rt-${overrides.uid}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "device-flow",
    },
    ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
  };
}

function tempDir(prefix = "codebuffy-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}


// ---- normalizePoolFile -----------------------------------------------------

describe("normalizePoolFile", () => {
  it("normalizes camelCase pool file from onboard-account.mjs", () => {
    const now = Date.now();
    const raw = {
      version: 1,
      label: "acc-a",
      domain: "www.codebuddy.cn",
      apiBase: "https://copilot.tencent.com",
      account: { uid: "uid-pool-camel", enterpriseId: "ent-1", nickname: "alice" },
      auth: {
        accessToken: "AT_camel",
        refreshToken: "RT_camel",
        tokenType: "Bearer",
        domain: "www.codebuddy.cn",
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 120_000,
        capturedAt: now,
        source: "device-flow",
      },
      apiKey: { name: "codebuffy-acc-a", keyId: "kid-1", fullKey: "ck_test_123" },
    };

    const cred = normalizePoolFile(raw);
    expect(cred.uid).toBe("uid-pool-camel");
    expect(cred.label).toBe("acc-a");
    expect(cred.domain).toBe("www.codebuddy.cn");
    expect(cred.apiBase).toBe("https://copilot.tencent.com");
    expect(cred.consoleBase).toBe("https://www.codebuddy.cn");
    expect(cred.enterpriseId).toBe("ent-1");
    expect(cred.nickname).toBe("alice");
    expect(cred.auth.accessToken).toBe("AT_camel");
    expect(cred.auth.refreshToken).toBe("RT_camel");
    expect(cred.auth.expiresAt).toBe(raw.auth.expiresAt);
    expect(cred.auth.refreshExpiresAt).toBe(raw.auth.refreshExpiresAt);
    expect(cred.apiKey?.fullKey).toBe("ck_test_123");
  });

  it("normalizes snake_case desktop auth file (Tom6814)", () => {
    const now = Date.now();
    const raw = {
      auth: {
        access_token: "AT_snake",
        refresh_token: "RT_snake",
        token_type: "Bearer",
        domain: "www.codebuddy.cn",
        expires_at: now + 90_000,
        refresh_expires_at: now + 180_000,
        captured_at: now,
        source: "auth-file:/tmp/workbuddy-desktop.info",
      },
      account: {
        uid: "uid-desktop-snake",
        nickname: "bob",
        enterpriseId: "ent-snake",
      },
    };

    const cred = normalizePoolFile(raw);
    expect(cred.uid).toBe("uid-desktop-snake");
    expect(cred.auth.accessToken).toBe("AT_snake");
    expect(cred.auth.refreshToken).toBe("RT_snake");
    expect(cred.auth.expiresAt).toBe(raw.auth.expires_at);
    expect(cred.auth.refreshExpiresAt).toBe(raw.auth.refresh_expires_at);
    expect(cred.nickname).toBe("bob");
  });

  it("handles expiresIn relative seconds (both camel and snake)", () => {
    const before = Date.now();
    const rawCamel = {
      account: { uid: "uid-exp-camel" },
      auth: {
        accessToken: "AT1",
        refreshToken: "RT1",
        expiresIn: 3600,
        refreshExpiresIn: 7200,
      },
    };
    const c1 = normalizePoolFile(rawCamel);
    // expiresAt should be ~ now + 3600*1000
    expect(c1.auth.expiresAt).toBeGreaterThanOrEqual(before + 3599_000);
    expect(c1.auth.expiresAt).toBeLessThanOrEqual(Date.now() + 3601_000);
    expect(c1.auth.refreshExpiresAt).toBeGreaterThanOrEqual(before + 7199_000);

    const rawSnake = {
      account: { uid: "uid-exp-snake" },
      auth: {
        access_token: "AT2",
        refresh_token: "RT2",
        expires_in: 1800,
        refresh_expires_in: 3600,
      },
    };
    const c2 = normalizePoolFile(rawSnake);
    expect(c2.auth.expiresAt).toBeGreaterThanOrEqual(before + 1799_000);
    expect(c2.auth.refreshExpiresAt).toBeGreaterThanOrEqual(before + 3599_000);
  });

  it("handles expires_at as seconds epoch (converts to ms)", () => {
    // seconds epoch: 1_700_000_000 (~2023) -> ms epoch 1_700_000_000_000
    const secEpoch = 1_750_000_000;
    const raw = {
      account: { uid: "uid-sec-epoch" },
      auth: {
        access_token: "AT",
        refresh_token: "RT",
        expires_at: secEpoch,
        refresh_expires_at: secEpoch + 1000,
      },
    };
    const c = normalizePoolFile(raw);
    expect(c.auth.expiresAt).toBe(secEpoch * 1000);
    expect(c.auth.refreshExpiresAt).toBe((secEpoch + 1000) * 1000);
  });

  it("handles direct DB row shape (already normalized Credential)", () => {
    const cred = makeCredential({ uid: "uid-db-row", label: "direct" });
    const raw = JSON.parse(JSON.stringify(cred)); // simulate parsed DB JSON
    const out = normalizePoolFile(raw);
    expect(out.uid).toBe(cred.uid);
    expect(out.auth.accessToken).toBe(cred.auth.accessToken);
    expect(out.auth.refreshToken).toBe(cred.auth.refreshToken);
    expect(out.apiBase).toBe(cred.apiBase);
  });

  it("handles token_info + user_id snake variants", () => {
    const now = Date.now();
    const raw = {
      token_info: {
        access_token: "AT_ti",
        refresh_token: "RT_ti",
        expires_at: now + 5000,
        refresh_expires_at: now + 10000,
      },
      account: {
        user_id: "uid-tokeninfo",
      },
    };
    const c = normalizePoolFile(raw);
    expect(c.uid).toBe("uid-tokeninfo");
    expect(c.auth.accessToken).toBe("AT_ti");
  });

  it("normalizes apiKey snake_case variants", () => {
    const now = Date.now();
    const raw = {
      account: { uid: "uid-apikey" },
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        expiresAt: now + 60000,
        refreshExpiresAt: now + 120000,
      },
      api_key: { name: "mykey", key_id: "kid-999", full_key: "ck_snake_abc" },
    };
    const c = normalizePoolFile(raw);
    expect(c.apiKey?.name).toBe("mykey");
    expect(c.apiKey?.keyId).toBe("kid-999");
    expect(c.apiKey?.fullKey).toBe("ck_snake_abc");
  });

  it("throws readable error when required fields missing", () => {
    expect(() => normalizePoolFile({ account: { uid: "x" }, auth: { accessToken: "AT" } })).toThrow(
      /refreshToken/,
    );
    expect(() => normalizePoolFile({ auth: { accessToken: "AT", refreshToken: "RT" } })).toThrow(/uid/);
    expect(() =>
      normalizePoolFile({ account: { uid: "u" }, auth: { refreshToken: "RT" } }),
    ).toThrow(/accessToken/);
    expect(() => normalizePoolFile(null as unknown as Record<string, unknown>)).toThrow(/expected an object/);
  });

  it("defaults domain/apiBase/consoleBase when absent", () => {
    const now = Date.now();
    const raw = {
      account: { uid: "uid-defaults" },
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        expiresAt: now + 60000,
        refreshExpiresAt: now + 120000,
      },
    };
    const c = normalizePoolFile(raw);
    expect(c.domain).toBe("www.codebuddy.cn");
    expect(c.apiBase).toBe("https://copilot.tencent.com");
    expect(c.consoleBase).toBe("https://www.codebuddy.cn");
  });
});

describe("isExpiring", () => {
  it("returns true when expiresAt is within skew", () => {
    const now = Date.now();
    const cred = makeCredential({
      uid: "u1",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 60_000, // 1 min
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    });
    expect(isExpiring(cred, 5 * 60 * 1000)).toBe(true); // 5 min skew -> expiring
    expect(isExpiring(cred, 30 * 1000)).toBe(false); // 30s skew -> not expiring? wait 60s >30s so false - correct? Actually expires 60s ahead, skew 30s => not within skew => false
    // Check predicate: expiresAt <= now + skew =>  now+60s <= now+300s true, <= now+30s false
  });

  it("uses default 5 min skew", () => {
    const now = Date.now();
    const credSoon = makeCredential({
      uid: "u2",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 2 * 60 * 1000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    });
    expect(isExpiring(credSoon)).toBe(true);
    const credLater = makeCredential({
      uid: "u3",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 10 * 60 * 1000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    });
    expect(isExpiring(credLater)).toBe(false);
  });

  it("returns true for already-expired token", () => {
    const now = Date.now();
    const cred = makeCredential({
      uid: "u4",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now - 1000,
        refreshExpiresAt: now - 500,
        capturedAt: now - 3600_000,
        source: "device-flow",
      },
    });
    expect(isExpiring(cred)).toBe(true);
  });
});

// ---- SqliteCredentialStore -------------------------------------------------

describe("SqliteCredentialStore", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteCredentialStore;

  function freshStore() {
    dir = tempDir("codebuffy-cred-");
    dbPath = path.join(dir, "test.db");
    store = new SqliteCredentialStore(dbPath);
    return store;
  }

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("upsert/get/list/delete round-trip", () => {
    freshStore();
    const c1 = makeCredential({ uid: "uid-1", label: "first" });
    const c2 = makeCredential({ uid: "uid-2", label: "second" });

    // initially empty
    expect(store.list()).toEqual([]);

    store.upsert(c1);
    expect(store.get("uid-1")?.auth.accessToken).toBe(c1.auth.accessToken);
    expect(store.list()).toHaveLength(1);

    store.upsert(c2);
    expect(store.list()).toHaveLength(2);
    const uids = store.list().map((c) => c.uid).sort();
    expect(uids).toEqual(["uid-1", "uid-2"]);

    // replace
    const c1Updated = makeCredential({ uid: "uid-1", label: "first-updated" });
    c1Updated.auth.accessToken = "AT_updated";
    store.upsert(c1Updated);
    expect(store.list()).toHaveLength(2);
    expect(store.get("uid-1")?.auth.accessToken).toBe("AT_updated");
    expect(store.get("uid-1")?.label).toBe("first-updated");

    // delete
    store.delete("uid-1");
    expect(store.get("uid-1")).toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.uid).toBe("uid-2");

    // delete non-existent is no-op
    store.delete("nope");
    expect(store.list()).toHaveLength(1);
  });

  it("persists and round-trips all credential fields", () => {
    freshStore();
    const c = makeCredential({
      uid: "uid-full",
      label: "full-creds",
      enterpriseId: "ent-full",
      nickname: "nick",
    });
    c.apiKey = { name: "mykey", keyId: "kid", fullKey: "ck_full_12345" };
    store.upsert(c);
    const fetched = store.get("uid-full");
    expect(fetched).toEqual(c);
  });

  it("ensures data dir exists (mkdir -p)", () => {
    const base = tempDir("codebuffy-nested-");
    const nestedDir = path.join(base, "a", "b");
    const nestedPath = path.join(nestedDir, "db.sqlite");
    const s = new SqliteCredentialStore(nestedPath);
    try {
      expect(fs.existsSync(nestedDir)).toBe(true);
      s.upsert(makeCredential({ uid: "uid-nested" }));
      expect(s.get("uid-nested")?.uid).toBe("uid-nested");
    } finally {
      s.close();
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {}
    }
  });

  it("stores expires_at and label as convenience columns without leaking token bodies", () => {
    freshStore();
    const c = makeCredential({ uid: "uid-inspect", label: "inspect-label" });
    c.auth.accessToken = "AT_SECRET_INSPECT";
    c.auth.refreshToken = "RT_SECRET_INSPECT";
    c.apiKey = { name: "k", fullKey: "ck_secret_key_value" };
    store.upsert(c);

    // Open a second handle to inspect raw DB columns
    const rawDb = new Database(dbPath);
    try {
      const row = rawDb
        .prepare("SELECT uid, data, expires_at, label FROM credentials WHERE uid = ?")
        .get("uid-inspect") as {
        uid: string;
        data: string;
        expires_at: number;
        label: string;
      };
      expect(row.uid).toBe("uid-inspect");
      expect(row.expires_at).toBe(c.auth.expiresAt);
      expect(row.label).toBe("inspect-label");
      // convenience columns must not contain token material
      expect(String(row.expires_at)).not.toContain("AT_SECRET");
      expect(String(row.label)).not.toContain("AT_SECRET");
      // data column is the JSON blob — it will contain tokens (needed for get) but
      // the convenience columns/index must not duplicate them.
      const parsed = JSON.parse(row.data) as Credential;
      expect(parsed.auth.accessToken).toBe("AT_SECRET_INSPECT");
      // Ensure index exists on expires_at
      const idx = rawDb.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_credentials_expires_at'").get() as
        | { name: string }
        | undefined;
      expect(idx?.name).toBe("idx_credentials_expires_at");
    } finally {
      rawDb.close();
    }
  });

  it("uses WAL journal mode and creates table with expected schema", () => {
    freshStore();
    const rawDb = new Database(dbPath);
    try {
      const jm = rawDb.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      expect(jm.journal_mode.toLowerCase()).toBe("wal");
      const tableInfo = rawDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='credentials'").get() as
        | { sql: string }
        | undefined;
      expect(tableInfo?.sql).toContain("uid TEXT PRIMARY KEY");
      expect(tableInfo?.sql).toContain("data TEXT NOT NULL");
      expect(tableInfo?.sql).toContain("expires_at");
    } finally {
      rawDb.close();
    }
  });

  it("listExpiringSoon filters via isExpiring", () => {
    freshStore();
    const now = Date.now();
    const soon = makeCredential({
      uid: "uid-soon",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    });
    const later = makeCredential({
      uid: "uid-later",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 10 * 60_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    });
    const expired = makeCredential({
      uid: "uid-expired",
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now - 5_000,
        refreshExpiresAt: now - 1_000,
        capturedAt: now - 3600_000,
        source: "device-flow",
      },
    });
    store.upsert(soon);
    store.upsert(later);
    store.upsert(expired);

    const expiringDefault = store.listExpiringSoon(); // 5 min
    const uidsDefault = expiringDefault.map((c) => c.uid).sort();
    expect(uidsDefault).toEqual(["uid-expired", "uid-soon"]);

    const expiringShort = store.listExpiringSoon(30 * 1000);
    const uidsShort = expiringShort.map((c) => c.uid).sort();
    expect(uidsShort).toEqual(["uid-expired"]); // only already expired

    const expiringLong = store.listExpiringSoon(20 * 60 * 1000);
    expect(expiringLong).toHaveLength(3);
  });

  it("close() closes handle; subsequent use throws or is no-op", () => {
    freshStore();
    store.upsert(makeCredential({ uid: "uid-close" }));
    store.close();
    // after close, operations should throw (sqlite handle closed)
    expect(() => store.list()).toThrow();
    // create a new store on same path should reopen fine
    const s2 = new SqliteCredentialStore(dbPath);
    try {
      expect(s2.get("uid-close")?.uid).toBe("uid-close");
    } finally {
      s2.close();
    }
  });
});

// ---- file-importer ---------------------------------------------------------

describe("importPoolDir", () => {
  let poolDir: string;
  let storeDir: string;
  let store: SqliteCredentialStore;

  function freshStoreForImport() {
    storeDir = tempDir("codebuffy-import-store-");
    const p = path.join(storeDir, "import.db");
    store = new SqliteCredentialStore(p);
    return store;
  }

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    for (const d of [poolDir, storeDir]) {
      if (d) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  it("happy path: imports mixed camelCase and snake_case pool files", async () => {
    poolDir = tempDir("codebuffy-pool-happy-");
    freshStoreForImport();
    const now = Date.now();

    const camel = {
      version: 1,
      label: "camel-acc",
      domain: "www.codebuddy.cn",
      apiBase: "https://copilot.tencent.com",
      account: { uid: "uid-pool-1", enterpriseId: "ent-1" },
      auth: {
        accessToken: "AT_camel_1",
        refreshToken: "RT_camel_1",
        tokenType: "Bearer",
        domain: "www.codebuddy.cn",
        expiresAt: now + 3600_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    };
    const snake = {
      auth: {
        access_token: "AT_snake_1",
        refresh_token: "RT_snake_1",
        token_type: "Bearer",
        domain: "www.codebuddy.cn",
        expires_at: now + 3600_000,
        refresh_expires_at: now + 7200_000,
        captured_at: now,
        source: "auth-file:/tmp/x.info",
      },
      account: { uid: "uid-pool-2", enterpriseId: "ent-2", nickname: "snake-user" },
      label: "snake-acc",
    };

    fs.writeFileSync(path.join(poolDir, "uid-pool-1.json"), JSON.stringify(camel, null, 2));
    fs.writeFileSync(path.join(poolDir, "uid-pool-2.json"), JSON.stringify(snake, null, 2));
    // non-json file should be ignored
    fs.writeFileSync(path.join(poolDir, "README.txt"), "not json");

    const result = await importPoolDir(poolDir, store);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(store.list()).toHaveLength(2);
    expect(store.get("uid-pool-1")?.auth.accessToken).toBe("AT_camel_1");
    expect(store.get("uid-pool-2")?.auth.refreshToken).toBe("RT_snake_1");
    expect(store.get("uid-pool-2")?.label).toBe("snake-acc");
  });

  it("tolerates per-file parse failure (invalid JSON + missing fields)", async () => {
    poolDir = tempDir("codebuffy-pool-skip-");
    freshStoreForImport();
    const now = Date.now();

    const valid = {
      account: { uid: "uid-valid" },
      auth: {
        accessToken: "AT_valid",
        refreshToken: "RT_valid",
        expiresAt: now + 3600_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
    };
    fs.writeFileSync(path.join(poolDir, "valid.json"), JSON.stringify(valid));
    fs.writeFileSync(path.join(poolDir, "bad-json.json"), "{ not valid json :::");
    fs.writeFileSync(
      path.join(poolDir, "missing-field.json"),
      JSON.stringify({ account: { uid: "uid-no-token" }, auth: { accessToken: "only-at" } }),
    );
    // file with expiresIn relative
    const withExpiresIn = {
      account: { uid: "uid-relative" },
      auth: {
        access_token: "AT_rel",
        refresh_token: "RT_rel",
        expires_in: 3600,
        refresh_expires_in: 7200,
      },
    };
    fs.writeFileSync(path.join(poolDir, "relative.json"), JSON.stringify(withExpiresIn));

    const result = await importPoolDir(poolDir, store);
    expect(result.imported).toBe(2); // valid + relative
    expect(result.skipped).toBe(2); // bad-json + missing-field
    expect(store.get("uid-valid")?.uid).toBe("uid-valid");
    expect(store.get("uid-relative")?.uid).toBe("uid-relative");
    expect(store.get("uid-no-token")).toBeNull();
  });

  it("handles mixed formats including apiKey and desktop shape in same dir", async () => {
    poolDir = tempDir("codebuffy-pool-mixed-");
    freshStoreForImport();
    const now = Date.now();

    // onboard pool file with apiKey
    const withKey = {
      version: 1,
      label: "with-key",
      domain: "www.codebuddy.cn",
      apiBase: "https://copilot.tencent.com",
      account: { uid: "uid-with-key" },
      auth: {
        accessToken: "AT_k",
        refreshToken: "RT_k",
        expiresAt: now + 3600_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "device-flow",
      },
      apiKey: { name: "mykey", keyId: "kid", fullKey: "ck_abc123" },
    };
    // desktop file with expiresIn relative
    const desktopRelative = {
      auth: {
        access_token: "AT_d",
        refresh_token: "RT_d",
        expires_in: 5184000,
        refresh_expires_in: 7776000,
      },
      account: { uid: "uid-desktop-rel" },
    };
    // direct DB row shape (already Credential)
    const direct = makeCredential({ uid: "uid-direct", label: "direct" });

    fs.writeFileSync(path.join(poolDir, "with-key.json"), JSON.stringify(withKey));
    fs.writeFileSync(path.join(poolDir, "desktop.json"), JSON.stringify(desktopRelative));
    fs.writeFileSync(path.join(poolDir, "direct.json"), JSON.stringify(direct));

    const result = await importPoolDir(poolDir, store);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(store.get("uid-with-key")?.apiKey?.fullKey).toBe("ck_abc123");
    expect(store.get("uid-desktop-rel")?.auth.accessToken).toBe("AT_d");
    // relative expiry should be in future
    expect(store.get("uid-desktop-rel")!.auth.expiresAt).toBeGreaterThan(now);
    expect(store.get("uid-direct")?.label).toBe("direct");
  });

  it("returns zeros for non-existent directory", async () => {
    freshStoreForImport();
    const nonExist = path.join(os.tmpdir(), `codebuffy-nope-${Date.now()}-${Math.random()}`);
    const result = await importPoolDir(nonExist, store);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("handles empty directory", async () => {
    poolDir = tempDir("codebuffy-pool-empty-");
    freshStoreForImport();
    const result = await importPoolDir(poolDir, store);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
