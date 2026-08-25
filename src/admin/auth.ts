import type { Context } from "hono";

/**
 * Returns true for loopback hosts only.
 * Covers: 127.0.0.1, ::1, ::ffff:127.0.0.1, localhost (case-insensitive).
 * Used to enforce LAN-only default per blueprint (CODEBUFFY_HOST 127.0.0.1).
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  // Strip port if present (e.g. 127.0.0.1:3000, [::1]:3000)
  let bare = h;
  // IPv6 bracket form
  if (bare.startsWith("[")) {
    const end = bare.indexOf("]");
    if (end !== -1) bare = bare.slice(1, end);
  } else if (bare.includes(":") && !bare.includes("::")) {
    // host:port for ipv4/hostname — split on last colon only if not ipv6
    const lastColon = bare.lastIndexOf(":");
    const after = bare.slice(lastColon + 1);
    if (/^\d+$/.test(after)) bare = bare.slice(0, lastColon);
  }
  // Also handle bare ipv6 without brackets? e.g. ::1
  // Already lowercased.
  if (bare === "127.0.0.1" || bare === "::1" || bare === "::ffff:127.0.0.1" || bare === "localhost" || bare === "127.0.0.1%lo0") return true;
  // 127.0.0.0/8 loopback range — check 127.*.*.*
  if (/^127\.\d+\.\d+\.\d+$/.test(bare)) return true;
  return false;
}

/**
 * Validates CODEBUFFY_ADMIN_KEYS raw value (comma-split, >=8 chars per key).
 * Returns parsed keys array. Throws on invalid length.
 */
export function parseAdminKeys(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const keys = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of keys) {
    if (k.length < 8) throw new Error(`CODEBUFFY_ADMIN_KEYS entry too short (min 8 chars): "${k}"`);
  }
  return keys;
}

/**
 * Passkey stub — 501 until WebAuthn is implemented.
 * Mounted at POST /admin/auth/passkey.
 */
export const passkeyNotImplemented = (c: Context) => {
  return c.json({ error: { code: "NOT_IMPLEMENTED", message: "passkey pending" } }, 501);
};

// Alias for internal use (same reference)
export const passkeyNotImplementedHandler = passkeyNotImplemented;
