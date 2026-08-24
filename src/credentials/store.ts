import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Credential } from "./types";
import { isExpiring } from "./types";

export interface CredentialStore {
  upsert(cred: Credential): void;
  get(uid: string): Credential | null;
  list(): Credential[];
  delete(uid: string): void;
  close(): void;
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly db: Database;

  constructor(dbPath: string) {
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
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_credentials_expires_at ON credentials(expires_at);",
    );
  }

  upsert(cred: Credential): void {
    const data = JSON.stringify(cred);
    const expiresAt = cred.auth.expiresAt;
    const label = cred.label ?? null;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO credentials (uid, data, expires_at, label) VALUES (?, ?, ?, ?)",
      )
      .run(cred.uid, data, expiresAt, label);
  }

  get(uid: string): Credential | null {
    const row = this.db
      .prepare("SELECT data FROM credentials WHERE uid = ?")
      .get(uid) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as Credential;
  }

  list(): Credential[] {
    const rows = this.db.prepare("SELECT data FROM credentials").all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as Credential);
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
