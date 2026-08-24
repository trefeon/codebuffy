import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config";

/**
 * Downstream API-key gate.
 *
 * - Open mode when `config.downstreamApiKeys` is empty (any client allowed).
 * - Otherwise requires `Authorization: Bearer <key>` where key is in the allowlist.
 * - Uses timingSafeEqual for equal-length candidates to avoid trivial timing leaks.
 */
export function downstreamAuth(config: Config) {
  return async (c: Context, next: Next) => {
    if (config.downstreamApiKeys.length === 0) {
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return c.json(
        {
          error: {
            message: "Missing API key — expected Authorization: Bearer <key>",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    const token = header.slice(7).trim();
    if (!token) {
      return c.json(
        {
          error: {
            message: "Missing API key — expected Authorization: Bearer <key>",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    let valid = false;
    for (const key of config.downstreamApiKeys) {
      if (key.length !== token.length) continue;
      try {
        if (timingSafeEqual(Buffer.from(key), Buffer.from(token))) {
          valid = true;
          break;
        }
      } catch {
        // timingSafeEqual can throw on length mismatch (already guarded) — fallback
        if (key === token) {
          valid = true;
          break;
        }
      }
    }

    // Non-equal-length keys cannot match via timingSafeEqual; explicit fallback for completeness
    if (!valid) {
      for (const key of config.downstreamApiKeys) {
        if (key === token) {
          valid = true;
          break;
        }
      }
    }

    if (!valid) {
      return c.json(
        {
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    await next();
  };
}
