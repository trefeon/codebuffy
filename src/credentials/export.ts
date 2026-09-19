import { encrypt, isEncryptedPayload, type EncryptedPayload } from "./crypto";
import type { Credential } from "./types";
import type { CredentialStore } from "./store";

/** Bundle format version. Import rejects anything else. */
export const EXPORT_VERSION = 1 as const;

/** Thrown fail-closed: no plaintext export, no key generation. */
export class ExportError extends Error {
 constructor(message: string) {
  super(message);
  this.name = "ExportError";
 }
}

export interface ExportCredentialEntry {
 uid: string;
 label?: string;
 domain: string;
 apiBase: string;
 consoleBase: string;
 checkinEnabled: boolean;
 /** AES-256-GCM packet: existing encrypted_data passthrough, else fresh encrypt. */
 packet: EncryptedPayload;
}

export interface ExportBundle {
 version: typeof EXPORT_VERSION;
 exportedAt: number;
 credentials: ExportCredentialEntry[];
}

/** Explicit key wins; otherwise the store's own key (SqliteCredentialStore). */
function resolveKey(store: CredentialStore, key: Buffer | null): Buffer | null {
 if (key) return key;
 const candidate: unknown = store;
 if (
  candidate &&
  typeof candidate === "object" &&
  "getEncryptionKey" in candidate &&
  typeof candidate.getEncryptionKey === "function"
 ) {
  try {
   // In-process store method, not external input: narrow via `in`, then bind.
   const getKey = candidate.getEncryptionKey as (this: CredentialStore) => Buffer | null;
   return getKey.call(store) ?? null;
  } catch {
   return null;
  }
 }
 return null;
}

interface RawRow {
 uid: unknown;
 encrypted_data: unknown;
}

interface RawDb {
 prepare(sql: string): { all(...params: unknown[]): RawRow[] };
}

function isRawDb(value: unknown): value is RawDb {
 return (
  !!value &&
  typeof value === "object" &&
  "prepare" in value &&
  typeof value.prepare === "function"
 );
}

/**
 * Read raw encrypted_data packets keyed by uid when the store is
 * sqlite-backed (its private bun:sqlite handle is reachable at runtime).
 * Defensive: any shape mismatch yields an empty map and the caller falls
 * back to the encrypt path. Never throws.
 */
function readRawPackets(store: CredentialStore): Map<string, EncryptedPayload> {
 const out = new Map<string, EncryptedPayload>();
 try {
  const holder: unknown = store;
  if (!holder || typeof holder !== "object" || !("db" in holder)) return out;
  const db: unknown = holder.db;
  if (!isRawDb(db)) return out;
  const rows = db.prepare("SELECT uid, encrypted_data FROM credentials").all();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
   if (typeof row.uid !== "string" || typeof row.encrypted_data !== "string") continue;
   if (row.encrypted_data === "") continue;
   let parsed: unknown;
   try {
    parsed = JSON.parse(row.encrypted_data);
   } catch {
    continue;
   }
   if (!isEncryptedPayload(parsed)) continue;
   const tag = (parsed.tag ?? parsed.authTag) as string;
   if (typeof tag !== "string") continue;
   out.set(row.uid, { iv: parsed.iv, tag, ciphertext: parsed.ciphertext });
  }
 } catch {
  // Fall through with whatever was collected; caller encrypts the rest.
 }
 return out;
}

/**
 * Build an encrypted backup bundle for every credential in `store`.
 *
 * - Rows already carrying `encrypted_data` pass through untouched (same
 *   ciphertext, no re-encryption).
 * - Plaintext rows are encrypted with AES-256-GCM via crypto.ts using the
 *   explicit `key`, else the store's own key.
 * - Fail-closed: any plaintext row with no key available throws ExportError.
 *   Nothing plaintext ever leaves, and no key is ever generated here.
 */
export function buildExportBundle(store: CredentialStore, key?: Buffer | null): ExportBundle {
 const creds = store.list();
 const effectiveKey = resolveKey(store, key ?? null);
 const raw = readRawPackets(store);
 const credentials: ExportCredentialEntry[] = creds.map((cred: Credential) => {
  let packet = raw.get(cred.uid);
  if (!packet) {
   if (!effectiveKey) {
    throw new ExportError(
     `cannot export credential "${cred.uid}" without CODEBUFFY_ENCRYPTION_KEY: ` +
     "row is not encrypted and no key is configured (refusing plaintext export)",
    );
   }
   const fresh = encrypt(JSON.stringify(cred), effectiveKey);
   packet = { iv: fresh.iv, tag: fresh.tag, ciphertext: fresh.ciphertext };
  }
  return {
   uid: cred.uid,
   ...(cred.label ? { label: cred.label } : {}),
   domain: cred.domain,
   apiBase: cred.apiBase,
   consoleBase: cred.consoleBase,
   checkinEnabled: cred.checkinEnabled ?? false,
   packet,
  };
 });
 return { version: EXPORT_VERSION, exportedAt: Date.now(), credentials };
}
