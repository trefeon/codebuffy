import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config";
import type { Logger } from "../logger";

type AdminConfig = Config & {
  adminKeys?: string[];
  adminApiKeys?: string[];
  admin_keys?: string[];
};

/**
 * Admin API-key gate for /admin/*.
 *
 * Resolution order:
 *  1. If CODEBUFFY_ADMIN_KEYS (config.adminKeys) is non-empty -> require Bearer match against it.
 *  2. Else if downstreamApiKeys is non-empty -> allow downstream keys as admin fallback (documented in patch).
 *  3. Else open mode (no keys configured) but emit warn log.
 *
 * All comparisons use timingSafeEqual when lengths match — no plaintext fallback.
 */
function extractAdminKeys(config: AdminConfig): string[] {
  if (Array.isArray(config.adminKeys)) return config.adminKeys;
  if (Array.isArray(config.adminApiKeys)) return config.adminApiKeys;
  if (Array.isArray(config.admin_keys)) return config.admin_keys;
  return [];
}

function isValidToken(token: string, keys: string[]): boolean {
  for (const key of keys) {
    if (key.length !== token.length) continue;
    if (timingSafeEqual(Buffer.from(key), Buffer.from(token))) return true;
  }
  return false;
}

export function adminAuth(config: AdminConfig, logger?: Pick<Logger, "warn">) {
  return async (c: Context, next: Next) => {
    const adminKeys = extractAdminKeys(config);
    const downstreamKeys: string[] = config.downstreamApiKeys ?? [];

    let allowedKeys: string[] | null = null;

    if (adminKeys.length > 0) {
      allowedKeys = adminKeys;
    } else if (downstreamKeys.length > 0) {
      allowedKeys = downstreamKeys;
    } else {
      logger?.warn("[adminAuth] no admin keys configured — /admin/* is open (set CODEBUFFY_ADMIN_KEYS)");
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Missing admin credentials" } }, 401);
    }
    const token = header.slice(7).trim();
    if (!token) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Missing admin credentials" } }, 401);
    }

    if (!isValidToken(token, allowedKeys as string[])) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid admin credentials" } }, 401);
    }

    await next();
  };
}

