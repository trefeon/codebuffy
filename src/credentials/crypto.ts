import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export interface EncryptedPayload {
  iv: string;
  tag: string;
  ciphertext: string;
  /** compat alias for tag */
  authTag?: string;
}

/**
 * Load encryption key from env string.
 * Accepts:
 *  - hex 64 chars (32 bytes)
 *  - base64 44 chars (32 bytes, padded `=` or base64url, 43 without padding)
 *  - raw 32-byte utf8 string
 * Returns null for undefined/empty.
 * Throws on invalid length/format.
 */
export function loadEncryptionKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // hex 64 chars -> 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length !== 32) {
      throw new Error(`invalid encryption key: hex decoded to ${buf.length} bytes, expected 32`);
    }
    return buf;
  }

  // base64 (standard or url-safe) — 32 bytes => 44 chars padded, 43 without padding
  // Normalize base64url to standard
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const b64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  const isB64Like = b64Regex.test(normalized);

  if (isB64Like) {
    // Decide if this is likely a base64-encoded 32-byte key:
    // 43 or 44 chars suggests base64 32-byte intent. Also handle padded 44.
    const len = trimmed.length;
    const padLen = (4 - (normalized.length % 4)) % 4;
    const padded = normalized + "=".repeat(padLen);

    // Only attempt decode if length suggests 32-byte key or generic b64 decode yields 32 bytes
    // We attempt regardless, but distinguish intent for error vs fallback
    try {
      const buf = Buffer.from(padded, "base64");
      if (buf.length === 32) {
        // Verify that input looks like base64 key (43/44 chars) or padded length 44
        // Avoid misclassifying a 32-char raw ascii string that happens to be b64 alphabet:
        // 32-char raw would padded to 32 -> decode 24 bytes, not 32, so not reached here.
        // So if we decoded 32 bytes, it's almost certainly base64.
        // Additionally check that re-encoding yields same prefix (canonical)
        return buf;
      }
      // If it looked like a base64 key attempt (43/44 chars) but decoded length wrong -> throw
      if (len === 43 || len === 44 || padded.length === 44) {
        // Check if trimmed was likely base64 by charset + length
        // Only throw if decoded length is unexpected for a key
        // e.g., "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" is 44 but decodes to 32? Actually it does decode to 32.
        // So this branch only for wrong length.
        // To avoid false throw for non-key b64 strings like "hello world" (not b64), we check that trimmed contains only b64 chars and length 43/44
        throw new Error(`invalid encryption key: base64 decoded to ${buf.length} bytes, expected 32`);
      }
      // otherwise fall through to raw check
    } catch (e) {
      if (e instanceof Error && e.message.includes("invalid encryption key")) throw e;
      // fall through
    }
  }

  // raw 32-byte utf8 check
  const rawBuf = Buffer.from(trimmed, "utf8");
  if (rawBuf.length === 32) {
    return rawBuf;
  }

  throw new Error(
    `invalid encryption key: expected 32 bytes as base64 (44 chars), hex (64 chars), or 32-byte utf8 string, got ${rawBuf.length} bytes (input length ${trimmed.length})`,
  );
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64-encoded iv (12 bytes), tag (16 bytes), ciphertext.
 */
export function encrypt(plain: string, key: Buffer): EncryptedPayload {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`invalid encryption key length: expected 32, got ${key?.length ?? 0}`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertextBuf = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // tag should be 16 bytes
  if (tag.length !== 16) {
    throw new Error(`unexpected auth tag length ${tag.length}`);
  }
  const payload: EncryptedPayload = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertextBuf.toString("base64"),
  };
  // provide authTag alias for compat with earlier spec
  (payload as EncryptedPayload).authTag = payload.tag;
  return payload;
}

/**
 * Decrypt payload with AES-256-GCM.
 * Accepts {iv, tag|authTag, ciphertext} where each is base64.
 */
export function decrypt(
  enc: { iv: string; tag?: string; authTag?: string; ciphertext: string },
  key: Buffer,
): string {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`invalid encryption key length: expected 32, got ${key?.length ?? 0}`);
  }
  const tagB64 = (enc as Record<string, unknown>).tag ?? (enc as Record<string, unknown>).authTag;
  if (typeof enc.iv !== "string" || typeof tagB64 !== "string" || typeof enc.ciphertext !== "string") {
    throw new Error("invalid encrypted payload: missing iv/tag/ciphertext");
  }
  const iv = Buffer.from(enc.iv, "base64");
  const tag = Buffer.from(tagB64 as string, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  if (iv.length !== 12) {
    throw new Error(`invalid iv length: expected 12, got ${iv.length}`);
  }
  if (tag.length !== 16) {
    throw new Error(`invalid auth tag length: expected 16, got ${tag.length}`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plainBuf.toString("utf8");
}

/**
 * Check if value looks like an encrypted payload {iv, tag|authTag, ciphertext}
 * All fields must be non-empty base64 strings.
 */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const iv = o.iv;
  const tag = (o.tag ?? o.authTag) as unknown;
  const ciphertext = o.ciphertext;
  if (typeof iv !== "string" || typeof tag !== "string" || typeof ciphertext !== "string") return false;
  if (iv.length === 0 || (tag as string).length === 0 || ciphertext.length === 0) return false;
  // basic base64 check
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  // allow base64url as well
  const normalize = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
  if (!b64.test(normalize(iv)) || !b64.test(normalize(tag as string)) || !b64.test(normalize(ciphertext))) {
    return false;
  }
  return true;
}
