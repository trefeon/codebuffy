import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { SqliteCredentialStore } from "../src/credentials/store";
import type { Credential } from "../src/credentials/types";

function makeCredential(uid: string, overrides: Partial<Credential> = {}): Credential {
  const now = Date.now();
  const base: Credential = {
    uid,
    label: `label-${uid}`,
    domain: "https://api.example.com",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `AT_${uid}_${"x".repeat(20)}`,
      refreshToken: `RT_${uid}_${"y".repeat(20)}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
    ...overrides,
  };
  // deep merge auth if partial overrides includes auth
  if (overrides.auth) {
    base.auth = { ...base.auth, ...overrides.auth } as Credential["auth"];
  }
  return base as Credential;
}

function tempDir(prefix = "codebuffy-enc-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("SqliteCredentialStore encrypted", () => {
  let dir: string;
  let dbPath: string;
  const stores: SqliteCredentialStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) {
      try {
        s.close();
      } catch {}
    }
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      // @ts-expect-error — dir may be string | undefined after cleanup
      dir = undefined;
    }
  });

  function freshStore(key: Buffer | null, useMemory = false): SqliteCredentialStore {
    if (useMemory) {
      const s = new SqliteCredentialStore(":memory:", key);
      stores.push(s);
      return s;
    }
    dir = tempDir();
    dbPath = path.join(dir, "test.db");
    const s = new SqliteCredentialStore(dbPath, key);
    stores.push(s);
    return s;
  }

  it("writes encrypted_data and reads back when key provided", () => {
    const key = randomBytes(32);
    const store = freshStore(key);
    const cred = makeCredential("uid-enc-1");
    store.upsert(cred);

    const fetched = store.get("uid-enc-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.uid).toBe(cred.uid);
    expect(fetched!.auth.accessToken).toBe(cred.auth.accessToken);
    expect(fetched).toEqual(cred);

    // list also decrypts
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.uid).toBe(cred.uid);

    // isEncrypted flag
    expect(store.isEncrypted()).toBe(true);
    expect(store.getEncryptionKey()!.equals(key)).toBe(true);
  });

  it("no plaintext leak when key set (data column not containing credential)", () => {
    const key = randomBytes(32);
    const store = freshStore(key);
    const cred = makeCredential("uid-leak");
    cred.auth.accessToken = "AT_SUPER_SECRET_LEAKTEST";
    cred.auth.refreshToken = "RT_SUPER_SECRET_LEAKTEST";
    store.upsert(cred);

    // inspect raw DB
    const rawDb = new Database(dbPath);
    try {
      const row = rawDb
        .prepare("SELECT data, encrypted_data FROM credentials WHERE uid = ?")
        .get("uid-leak") as { data: string | null; encrypted_data: string | null };
      expect(row.encrypted_data).not.toBeNull();
      expect(row.encrypted_data!.length).toBeGreaterThan(20);
      // data column must not contain token
      const dataCol = row.data ?? "";
      expect(dataCol).not.toContain("AT_SUPER_SECRET_LEAKTEST");
      expect(dataCol).not.toContain("RT_SUPER_SECRET_LEAKTEST");
      // encrypted_data should be JSON with iv/tag/ciphertext
      const parsed = JSON.parse(row.encrypted_data!);
      expect(parsed.iv).toBeDefined();
      expect(parsed.tag ?? parsed.authTag).toBeDefined();
      expect(parsed.ciphertext).toBeDefined();
      // data column should be placeholder empty
      expect(dataCol === "" || dataCol === "__encrypted__" || dataCol.length < 20).toBe(true);
    } finally {
      rawDb.close();
    }
  });

  it("without key writes plaintext and reads back", () => {
    const store = freshStore(null);
    const cred = makeCredential("uid-plain");
    store.upsert(cred);

    const fetched = store.get("uid-plain");
    expect(fetched).toEqual(cred);
    expect(store.isEncrypted()).toBe(false);
    expect(store.getEncryptionKey()).toBeNull();

    const rawDb = new Database(dbPath);
    try {
      const row = rawDb
        .prepare("SELECT data, encrypted_data FROM credentials WHERE uid = ?")
        .get("uid-plain") as { data: string | null; encrypted_data: string | null };
      expect(row.data).toContain(cred.auth.accessToken);
      expect(row.encrypted_data).toBeNull();
    } finally {
      rawDb.close();
    }
  });

  it("migration: plaintext row readable after key added (fallback to data column)", () => {
    // Step 1: create plaintext row without key
    const key = randomBytes(32);
    dir = tempDir("migrate-");
    dbPath = path.join(dir, "migrate.db");
    {
      const plainStore = new SqliteCredentialStore(dbPath, null);
      stores.push(plainStore);
      const cred = makeCredential("uid-migrate");
      plainStore.upsert(cred);
      expect(plainStore.get("uid-migrate")?.uid).toBe("uid-migrate");
      plainStore.close();
      // remove from stores tracking (already closed)
      stores.pop();
    }
    // Step 2: reopen with key, old row should still be readable via fallback
    {
      const encStore = new SqliteCredentialStore(dbPath, key);
      stores.push(encStore);
      const fetched = encStore.get("uid-migrate");
      expect(fetched).not.toBeNull();
      expect(fetched!.uid).toBe("uid-migrate");
      // list should also return it
      expect(encStore.list().map((c) => c.uid)).toContain("uid-migrate");

      // Now upsert same uid with key -> should become encrypted
      const updated = makeCredential("uid-migrate");
      updated.auth.accessToken = "AT_NEW_AFTER_MIGRATE";
      encStore.upsert(updated);
      const after = encStore.get("uid-migrate");
      expect(after!.auth.accessToken).toBe("AT_NEW_AFTER_MIGRATE");

      // Verify data column no longer leaks after re-upsert
      const rawDb = new Database(dbPath);
      try {
        const row = rawDb
          .prepare("SELECT data, encrypted_data FROM credentials WHERE uid = ?")
          .get("uid-migrate") as { data: string | null; encrypted_data: string | null };
        expect(row.encrypted_data).not.toBeNull();
        expect(row.data ?? "").not.toContain("AT_NEW_AFTER_MIGRATE");
      } finally {
        rawDb.close();
      }
    }
  });

  it("encrypted row not readable without key (returns null)", () => {
    const key = randomBytes(32);
    dir = tempDir("enc-no-key-");
    dbPath = path.join(dir, "enc.db");
    {
      const encStore = new SqliteCredentialStore(dbPath, key);
      stores.push(encStore);
      const cred = makeCredential("uid-enc-noplain");
      encStore.upsert(cred);
      encStore.close();
      stores.pop();
    }
    {
      const plainStore = new SqliteCredentialStore(dbPath, null);
      stores.push(plainStore);
      const fetched = plainStore.get("uid-enc-noplain");
      // encrypted_data present but no key => null per spec
      expect(fetched).toBeNull();
      // list should skip encrypted rows when no key (no plaintext fallback)
      expect(plainStore.list()).toHaveLength(0);
    }
  });

  it("isEncrypted flag reflects constructor key", () => {
    const memPlain = freshStore(null, true);
    expect(memPlain.isEncrypted()).toBe(false);
    expect(memPlain.getEncryptionKey()).toBeNull();

    const key = randomBytes(32);
    const memEnc = freshStore(key, true);
    expect(memEnc.isEncrypted()).toBe(true);
    expect(memEnc.getEncryptionKey()!.equals(key)).toBe(true);
  });

  it("uses :memory: with encryption", () => {
    const key = randomBytes(32);
    const store = freshStore(key, true);
    const c1 = makeCredential("mem1");
    const c2 = makeCredential("mem2");
    store.upsert(c1);
    store.upsert(c2);
    expect(store.list()).toHaveLength(2);
    expect(store.get("mem1")?.uid).toBe("mem1");
    store.delete("mem1");
    expect(store.get("mem1")).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("ALTER TABLE adds encrypted_data column idempotently", () => {
    const key = randomBytes(32);
    const store = freshStore(key);
    store.upsert(makeCredential("uid-first"));
    // verify pragma has column
    const rawDb = new Database(dbPath);
    try {
      const cols = rawDb.prepare("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain("encrypted_data");
      expect(names).toContain("data");
    } finally {
      rawDb.close();
    }
    // reopen should not fail (ALTER idempotent)
    const s2 = new SqliteCredentialStore(dbPath, key);
    stores.push(s2);
    expect(s2.list()).toHaveLength(1); // previous row still there
    s2.upsert(makeCredential("uid-second"));
    expect(s2.list()).toHaveLength(2);
  });

  it("handles listExpiringSoon with encrypted rows", () => {
    const key = randomBytes(32);
    const store = freshStore(key, true);
    const now = Date.now();
    const soon = makeCredential("soon", {
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "test",
      },
    });
    const later = makeCredential("later", {
      auth: {
        accessToken: "AT",
        refreshToken: "RT",
        tokenType: "Bearer",
        expiresAt: now + 10 * 60_000,
        refreshExpiresAt: now + 7200_000,
        capturedAt: now,
        source: "test",
      },
    });
    store.upsert(soon);
    store.upsert(later);
    const expiring = store.listExpiringSoon();
    expect(expiring.map((c) => c.uid)).toContain("soon");
    expect(expiring.map((c) => c.uid)).not.toContain("later");
  });
});
