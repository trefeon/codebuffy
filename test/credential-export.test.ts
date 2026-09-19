import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SqliteCredentialStore } from "../src/credentials/store";
import { decrypt, isEncryptedPayload } from "../src/credentials/crypto";
import { normalizePoolFile, type Credential } from "../src/credentials/types";
import { importPoolDir } from "../src/credentials/file-importer";
import { buildExportBundle, ExportError } from "../src/credentials/export";

function makeCredential(uid: string, overrides: Partial<Credential> = {}): Credential {
  const now = Date.now();
  const base: Credential = {
    uid,
    label: `label-${uid}`,
    domain: "www.codebuddy.cn",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    checkinEnabled: true,
    auth: {
      accessToken: `access-${uid}-secret`,
      refreshToken: `refresh-${uid}-secret`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
  };
  return { ...base, ...overrides, auth: { ...base.auth, ...(overrides.auth ?? {}) } } as Credential;
}

function tempDir(prefix = "codebuffy-export-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const dirs: string[] = [];
const stores: SqliteCredentialStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      // ignore close errors on temp stores
    }
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("buildExportBundle", () => {
  it("encrypts plaintext rows with the provided key (round-trip)", () => {
    const key = randomBytes(32);
    // No store-level key -> rows are plaintext (data column only).
    const store = new SqliteCredentialStore(":memory:", null);
    stores.push(store);
    const cred = makeCredential("uid-1");
    store.upsert(cred);

    const bundle = buildExportBundle(store, key);

    expect(bundle.version).toBe(1);
    expect(typeof bundle.exportedAt).toBe("number");
    expect(bundle.credentials).toHaveLength(1);
    const [entry] = bundle.credentials;
    if (!entry) throw new Error("expected one credential in bundle");
    expect(entry.uid).toBe("uid-1");
    expect(entry.label).toBe("label-uid-1");
    expect(entry.domain).toBe("www.codebuddy.cn");
    expect(entry.apiBase).toBe("https://copilot.tencent.com");
    expect(entry.consoleBase).toBe("https://www.codebuddy.cn");
    expect(entry.checkinEnabled).toBe(true);
    expect(isEncryptedPayload(entry.packet)).toBe(true);

    // No plaintext leak in the serialized bundle.
    expect(JSON.stringify(bundle)).not.toContain("access-uid-1-secret");

    // Round-trip: decrypt -> normalize -> same identity/tokens.
    const plain = decrypt(entry.packet, key);
    const back = normalizePoolFile(JSON.parse(plain) as unknown);
    expect(back.uid).toBe("uid-1");
    expect(back.auth.accessToken).toBe("access-uid-1-secret");
    expect(back.auth.refreshToken).toBe("refresh-uid-1-secret");
  });

  it("throws ExportError when a row is plaintext and no key is configured", () => {
    const store = new SqliteCredentialStore(":memory:", null);
    stores.push(store);
    store.upsert(makeCredential("uid-1"));

    expect(() => buildExportBundle(store, null)).toThrow(ExportError);
    expect(() => buildExportBundle(store)).toThrow(ExportError);
  });

  it("returns an empty bundle without a key when the store is empty", () => {
    const store = new SqliteCredentialStore(":memory:", null);
    stores.push(store);

    const bundle = buildExportBundle(store, null);
    expect(bundle.version).toBe(1);
    expect(bundle.credentials).toEqual([]);
  });

  it("passes through existing encrypted_data instead of re-encrypting", () => {
    const key = randomBytes(32);
    const store = new SqliteCredentialStore(":memory:", key);
    stores.push(store);
    store.upsert(makeCredential("uid-1"));

    const first = buildExportBundle(store, key);
    const second = buildExportBundle(store, key);

    expect(first.credentials).toHaveLength(1);
    const a = first.credentials[0];
    const b = second.credentials[0];
    if (!a || !b) throw new Error("expected one credential in bundle");
    // Identical ciphertext across exports: passthrough of stored
    // encrypted_data, not a fresh random-IV encryption.
    expect(b.packet).toEqual(a.packet);
    expect(isEncryptedPayload(a.packet)).toBe(true);
    const plain = decrypt(a.packet, key);
    expect((JSON.parse(plain) as Credential).uid).toBe("uid-1");
  });

  it("falls back to the store key when no explicit key is passed", () => {
    const key = randomBytes(32);
    const store = new SqliteCredentialStore(":memory:", key);
    stores.push(store);
    store.upsert(makeCredential("uid-1"));

    const bundle = buildExportBundle(store);
    expect(bundle.credentials).toHaveLength(1);
    const single = bundle.credentials[0];
    if (!single) throw new Error("expected one credential in bundle");
    const plain = decrypt(single.packet, key);
    expect((JSON.parse(plain) as Credential).uid).toBe("uid-1");
  });

  it("export→import round-trips through the onboard import subcommand", async () => {
    const dir = tempDir();
    dirs.push(dir);
    const key = randomBytes(32);
    const keyB64 = key.toString("base64");
    const store = new SqliteCredentialStore(":memory:", null);
    stores.push(store);
    store.upsert(makeCredential("uid-1"));
    store.upsert(makeCredential("uid-2", { checkinEnabled: false }));

    const bundle = buildExportBundle(store, key);
    const bundlePath = path.join(dir, "bundle.json");
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));

    const poolDir = path.join(dir, "pool");
    const script = fileURLToPath(new URL("../scripts/onboard-account.mjs", import.meta.url));
    const proc = Bun.spawnSync([process.execPath, script, "import", bundlePath, "--out-dir", poolDir], {
      env: { ...process.env, CODEBUFFY_ENCRYPTION_KEY: keyB64 },
    });
    expect(proc.exitCode).toBe(0);

    const written = fs.readdirSync(poolDir).filter((f) => f.endsWith(".json")).sort();
    expect(written).toEqual(["uid-1.json", "uid-2.json"]);

    // Imported files reuse the pool-file shape: importPoolDir accepts them.
    const dest = new SqliteCredentialStore(":memory:", null);
    stores.push(dest);
    const result = await importPoolDir(poolDir, dest);
    expect(result).toEqual({ imported: 2, skipped: 0 });
    expect(dest.get("uid-1")?.auth.accessToken).toBe("access-uid-1-secret");
    expect(dest.get("uid-2")?.auth.refreshToken).toBe("refresh-uid-2-secret");
  });

  it("import subcommand rejects a non-v1 bundle", () => {
    const dir = tempDir();
    dirs.push(dir);
    const bundlePath = path.join(dir, "bundle.json");
    fs.writeFileSync(bundlePath, JSON.stringify({ version: 999, exportedAt: Date.now(), credentials: [] }));

    const script = fileURLToPath(new URL("../scripts/onboard-account.mjs", import.meta.url));
    const proc = Bun.spawnSync([process.execPath, script, "import", bundlePath, "--out-dir", path.join(dir, "pool")], {
      env: { ...process.env, CODEBUFFY_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("version");
  });
});
