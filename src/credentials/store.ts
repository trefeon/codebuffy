import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Credential } from "./types";
import { isExpiring } from "./types";
import { encrypt, decrypt, isEncryptedPayload } from "./crypto";

export interface CredentialStore {
  upsert(cred: Credential): void;
  get(uid: string): Credential | null;
  list(): Credential[];
  delete(uid: string): void;
  close(): void;
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly db: Database;
  private readonly encryptionKey: Buffer | null;

  constructor(dbPath: string, encryptionKey?: Buffer | null) {
    if (encryptionKey !== undefined && encryptionKey !== null) {
      if (!Buffer.isBuffer(encryptionKey)) {
        throw new Error("encryptionKey must be a Buffer");
      }
      if (encryptionKey.length !== 32) {
        throw new Error(`invalid encryption key length: expected 32, got ${encryptionKey.length}`);
      }
    }
    this.encryptionKey = encryptionKey ?? null;

    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (dir && dir !== "." && dir !== "/") {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);

    // WAL + NORMAL are the safe defaults for concurrent readers (research doc pattern)
    // Foreign keys on for future migrations.
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        uid TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires_at INTEGER,
        label TEXT
      );
    `);

    // Migration: add encrypted_data column if not exists (check pragma table_info)
    const cols = this.db.prepare("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
    const hasEncrypted = cols.some((c) => c.name === "encrypted_data");
    if (!hasEncrypted) {
      this.db.exec("ALTER TABLE credentials ADD COLUMN encrypted_data TEXT;");
    }

    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_credentials_expires_at ON credentials(expires_at);",
    );
  }

  isEncrypted(): boolean {
    return this.encryptionKey !== null;
  }

  getEncryptionKey(): Buffer | null {
    return this.encryptionKey;
  }

  upsert(cred: Credential): void {
    const expiresAt = cred.auth.expiresAt;
    const label = cred.label ?? null;

    if (this.encryptionKey) {
      const plain = JSON.stringify(cred);
      const enc = encrypt(plain, this.encryptionKey);
      const encryptedData = JSON.stringify(enc);
      // data column is NOT NULL in original schema, so store placeholder empty string to avoid leak.
      // No plaintext leak when key set: data column must not contain credential material.
      this.db
        .prepare(
          "INSERT OR REPLACE INTO credentials (uid, data, encrypted_data, expires_at, label) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cred.uid, "", encryptedData, expiresAt, label);
    } else {
      const data = JSON.stringify(cred);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO credentials (uid, data, encrypted_data, expires_at, label) VALUES (?, ?, ?, ?, ?)",
        )
        .run(cred.uid, data, null, expiresAt, label);
    }
  }

  get(uid: string): Credential | null {
    const row = this.db
      .prepare("SELECT data, encrypted_data FROM credentials WHERE uid = ?")
      .get(uid) as { data: string | null; encrypted_data: string | null } | undefined;
    if (!row) return null;

    // Try encrypted_data first (decrypt if key present)
    if (row.encrypted_data) {
      if (this.encryptionKey) {
        try {
          const parsed: unknown = JSON.parse(row.encrypted_data);
          if (isEncryptedPayload(parsed)) {
            const p = parsed as { iv: string; tag: string; ciphertext: string; authTag?: string };
            const normalized = {
              iv: p.iv,
              tag: (p.tag ?? p.authTag) as string,
              ciphertext: p.ciphertext,
            };
            if (normalized.tag) {
              const plain = decrypt(normalized, this.encryptionKey);
              return JSON.parse(plain) as Credential;
            }
          }
        } catch {
          // fall through to try plaintext fallback (migration or corrupted)
        }
      } else {
        // encrypted_data present but no key -> cannot decrypt, return null per spec
        // but try plaintext fallback if data column has readable credential (migration case where row was plaintext before encryption?)
        // For encrypted rows without key, we cannot return; strictly return null.
        // However if data column also contains plaintext (old row not yet migrated), we could fallback.
        // Decision: if encrypted_data present and no key, attempt fallback to data column before returning null.
      }
    }

    // Fallback to plaintext data column (migration: old rows without encrypted_data still readable regardless of key)
    if (row.data && row.data !== "" && row.data !== "__encrypted__") {
      try {
        return JSON.parse(row.data) as Credential;
      } catch {
        return null;
      }
    }

    // If we had encrypted_data but failed to decrypt and data fallback also empty, return null
    // For the case where encrypted_data present but no key and data empty, this is a true encrypted row with no key -> null
    return null;
  }

  list(): Credential[] {
    const rows = this.db
      .prepare("SELECT data, encrypted_data FROM credentials")
      .all() as Array<{ data: string | null; encrypted_data: string | null }>;
    const out: Credential[] = [];
    for (const row of rows) {
      let cred: Credential | null = null;

      if (row.encrypted_data) {
        if (this.encryptionKey) {
          try {
            const parsed: unknown = JSON.parse(row.encrypted_data);
            if (isEncryptedPayload(parsed)) {
              const p = parsed as { iv: string; tag: string; ciphertext: string; authTag?: string };
              const normalized = {
                iv: p.iv,
                tag: (p.tag ?? p.authTag) as string,
                ciphertext: p.ciphertext,
              };
              if (normalized.tag) {
                const plain = decrypt(normalized, this.encryptionKey);
                cred = JSON.parse(plain) as Credential;
              }
            }
          } catch {
            // fall through to plaintext fallback
            cred = null;
          }
          if (cred) {
            out.push(cred);
            continue;
          }
          // decrypt failed -> try plaintext fallback
        } else {
          // no key but encrypted_data present -> try plaintext fallback first, otherwise skip row
          // continue to fallback below; if fallback also fails, skip
        }
      }

      if (row.data && row.data !== "" && row.data !== "__encrypted__") {
        try {
          cred = JSON.parse(row.data) as Credential;
          if (cred) out.push(cred);
        } catch {
          // skip corrupted row
        }
      }
      // else skip row (encrypted without key and no plaintext fallback)
    }
    return out;
  }

  delete(uid: string): void {
    this.db.prepare("DELETE FROM credentials WHERE uid = ?").run(uid);
  }

  /**
   * Returns credentials whose access token is expiring within `skewMs`.
   * Filtering is done in JS via `isExpiring` to keep a single source of truth
   * for the expiry predicate (data-driven TTL, not a SQL assumption).
   */
  listExpiringSoon(skewMs = 5 * 60 * 1000): Credential[] {
    return this.list().filter((c) => isExpiring(c, skewMs));
  }

  close(): void {
    this.db.close();
  }
}
