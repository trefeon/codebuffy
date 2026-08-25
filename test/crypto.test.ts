import { describe, it, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { loadEncryptionKey, encrypt, decrypt, isEncryptedPayload } from "../src/credentials/crypto";

function makeKey(): Buffer {
  return randomBytes(32);
}

describe("loadEncryptionKey", () => {
  it("returns null for undefined and empty", () => {
    expect(loadEncryptionKey(undefined)).toBeNull();
    expect(loadEncryptionKey("")).toBeNull();
    expect(loadEncryptionKey("   ")).toBeNull();
  });

  it("loads hex 64 chars", () => {
    const key = randomBytes(32);
    const hex = key.toString("hex");
    expect(hex).toHaveLength(64);
    const loaded = loadEncryptionKey(hex);
    expect(loaded).not.toBeNull();
    expect(loaded!.toString("hex")).toBe(hex);

    const upper = hex.toUpperCase();
    const loadedUpper = loadEncryptionKey(upper);
    expect(loadedUpper!.toString("hex").toLowerCase()).toBe(hex);
  });

  it("loads base64 44 chars", () => {
    const key = randomBytes(32);
    const b64 = key.toString("base64"); // 44 chars with single =
    expect(b64.length).toBe(44);
    const loaded = loadEncryptionKey(b64);
    expect(loaded!.equals(key)).toBe(true);
  });

  it("loads base64 43 chars without padding (unpadded)", () => {
    const key = randomBytes(32);
    const b64 = key.toString("base64").replace(/=+$/, "");
    expect(b64.length).toBe(43);
    const loaded = loadEncryptionKey(b64);
    expect(loaded!.equals(key)).toBe(true);
  });

  it("loads raw 32-byte utf8", () => {
    const raw = "a".repeat(32);
    const loaded = loadEncryptionKey(raw);
    expect(loaded!.toString("utf8")).toBe(raw);
    expect(loaded!.length).toBe(32);
  });

  it("throws on invalid length / format", () => {
    expect(() => loadEncryptionKey("short")).toThrow(/invalid encryption key/);
    expect(() => loadEncryptionKey("a".repeat(31))).toThrow(/invalid encryption key/);
    expect(() => loadEncryptionKey("a".repeat(33))).toThrow(/invalid encryption key/);
    // hex length 63 invalid
    expect(() => loadEncryptionKey("a".repeat(64).replace(/.$/, "z"))).toThrow(); // non-hex
    expect(() => loadEncryptionKey("0".repeat(63))).toThrow(/invalid encryption key/);
    // base64 44 but wrong decoded length (e.g., 16 bytes key)
    const shortB64 = randomBytes(16).toString("base64");
    expect(() => loadEncryptionKey(shortB64)).toThrow(/invalid encryption key/);
  });

  it("trims whitespace", () => {
    const key = randomBytes(32);
    const b64 = key.toString("base64");
    const loaded = loadEncryptionKey(`  ${b64}  \n`);
    expect(loaded!.equals(key)).toBe(true);
  });
});

describe("encrypt / decrypt", () => {
  it("roundtrip passes", () => {
    const key = makeKey();
    const plain = "hello world — credential JSON payload";
    const enc = encrypt(plain, key);
    expect(enc.iv).toBeDefined();
    expect(enc.tag).toBeDefined();
    expect(enc.ciphertext).toBeDefined();
    // iv 12 bytes => base64 16 chars
    expect(Buffer.from(enc.iv, "base64").length).toBe(12);
    expect(Buffer.from(enc.tag, "base64").length).toBe(16);
    const dec = decrypt(enc, key);
    expect(dec).toBe(plain);
  });

  it("roundtrip with JSON credential-like string", () => {
    const key = makeKey();
    const cred = JSON.stringify({ uid: "u1", auth: { accessToken: "AT_" + "x".repeat(100) } });
    const enc = encrypt(cred, key);
    const dec = decrypt(enc, key);
    expect(dec).toBe(cred);
    expect(JSON.parse(dec).uid).toBe("u1");
  });

  it("encrypt produces different ciphertext for same plaintext (random IV)", () => {
    const key = makeKey();
    const e1 = encrypt("same", key);
    const e2 = encrypt("same", key);
    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("decrypt fails with wrong key", () => {
    const k1 = makeKey();
    const k2 = makeKey();
    const enc = encrypt("secret", k1);
    expect(() => decrypt(enc, k2)).toThrow();
  });

  it("tamper detection: modified tag fails", () => {
    const key = makeKey();
    const enc = encrypt("payload", key);
    const tagBuf = Buffer.from(enc.tag, "base64");
    tagBuf[0] = (tagBuf[0]! ^ 0xff) & 0xff;
    const tampered = { ...enc, tag: tagBuf.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("tamper detection: modified ciphertext fails", () => {
    const key = makeKey();
    const enc = encrypt("payload", key);
    const ctBuf = Buffer.from(enc.ciphertext, "base64");
    ctBuf[0] = (ctBuf[0]! ^ 0x01) & 0xff;
    const tampered = { ...enc, ciphertext: ctBuf.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("tamper detection: modified iv fails", () => {
    const key = makeKey();
    const enc = encrypt("payload", key);
    const ivBuf = Buffer.from(enc.iv, "base64");
    ivBuf[0] = (ivBuf[0]! ^ 0x01) & 0xff;
    const tampered = { ...enc, iv: ivBuf.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("throws on invalid key length for encrypt/decrypt", () => {
    const short = randomBytes(16);
    expect(() => encrypt("hi", short)).toThrow(/invalid encryption key length/);
    const key = makeKey();
    const enc = encrypt("hi", key);
    expect(() => decrypt(enc, short)).toThrow(/invalid encryption key length/);
  });

  it("decrypt accepts authTag alias", () => {
    const key = makeKey();
    const enc = encrypt("alias-test", key);
    const withAuthTag = { iv: enc.iv, authTag: enc.tag, ciphertext: enc.ciphertext };
    const dec = decrypt(withAuthTag as unknown as { iv: string; tag: string; ciphertext: string }, key);
    expect(dec).toBe("alias-test");
  });
});

describe("isEncryptedPayload", () => {
  it("returns true for valid payload", () => {
    const key = makeKey();
    const enc = encrypt("x", key);
    expect(isEncryptedPayload(enc)).toBe(true);
    // with authTag alias
    const alias = { iv: enc.iv, authTag: enc.tag, ciphertext: enc.ciphertext };
    expect(isEncryptedPayload(alias)).toBe(true);
  });

  it("returns false for invalid", () => {
    expect(isEncryptedPayload(null)).toBe(false);
    expect(isEncryptedPayload({})).toBe(false);
    expect(isEncryptedPayload({ iv: "a", tag: "b" })).toBe(false);
    expect(isEncryptedPayload({ iv: "not-base64!!!", tag: "b", ciphertext: "c" })).toBe(false);
    expect(isEncryptedPayload("string")).toBe(false);
  });
});
