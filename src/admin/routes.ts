import type { Hono } from "hono";
import type { Config } from "../config";
import type { Logger } from "../logger";
import type { CredentialStore } from "../credentials/store";
import type { Credential } from "../credentials/types";
import { passkeyNotImplemented } from "./auth";
import { listUsage } from "../observability/usage";
import { fetchUsageQuota, QuotaError } from "../upstream/usage-quota";

export interface CheckinSchedulerLike {
  trigger(uid: string): Promise<unknown>;
}

export interface MountAdminDeps {
  config: Config;
  logger: Logger;
  store: CredentialStore | null;
  startedAt?: number;
  pool?: {
    size(): number;
    getState?: (uid: string) => string | undefined;
    getStats?: () => unknown;
  };
  checkinScheduler?: CheckinSchedulerLike | null;
}

function sanitizeCredential(cred: Credential, state?: string | undefined) {
  // Never leak tokens or fullKey
  return {
    uid: cred.uid,
    label: cred.label ?? null,
    domain: cred.domain,
    expiresAt: cred.auth.expiresAt,
    // expose state if pool provides it
    state: state ?? null,
    checkinEnabled: cred.checkinEnabled ?? false,
  };
}

export function mountAdminRoutes(app: Hono, deps: MountAdminDeps): void {
  const { store, pool, logger } = deps;

  // GET /admin/credentials — list sans tokens
  app.get("/admin/credentials", (c) => {
    if (!store) return c.json({ error: { code: "UNAVAILABLE", message: "store not configured" } }, 503);
    const list = store.list();
    const sanitized = list.map((cred) => {
      const state = pool?.getState?.(cred.uid);
      return sanitizeCredential(cred, state);
    });
    return c.json({ credentials: sanitized });
  });

  // GET /admin/credentials/:uid — single without tokens
  app.get("/admin/credentials/:uid", (c) => {
    if (!store) return c.json({ error: { code: "UNAVAILABLE", message: "store not configured" } }, 503);
    const uid = c.req.param("uid");
    const cred = store.get(uid);
    if (!cred) {
      return c.json({ error: { code: "NOT_FOUND", message: `credential ${uid} not found` } }, 404);
    }
    const state = pool?.getState?.(cred.uid);
    return c.json({ credential: sanitizeCredential(cred, state) });
  });

  // DELETE /admin/credentials/:uid — delete
  app.delete("/admin/credentials/:uid", (c) => {
    if (!store) return c.json({ error: { code: "UNAVAILABLE", message: "store not configured" } }, 503);
    const uid = c.req.param("uid");
    const existing = store.get(uid);
    if (!existing) {
      return c.json({ error: { code: "NOT_FOUND", message: `credential ${uid} not found` } }, 404);
    }
    store.delete(uid);
    logger.info({ uid }, "admin deleted credential");
    return c.json({ ok: true, uid });
  });

  // GET /admin/pool/state — pool.getStats + by-uid state if available
  app.get("/admin/pool/state", (c) => {
    const size = pool?.size() ?? store?.list().length ?? 0;
    let stats: unknown = null;
    if (pool?.getStats) {
      try {
        stats = pool.getStats();
      } catch {
        stats = { size };
      }
    } else {
      stats = { size };
    }

    // Build by-uid state map if pool exposes getState
    let byUid: Record<string, string> | undefined;
    if (pool?.getState && store) {
      byUid = {};
      for (const cred of store.list()) {
        const s = pool.getState(cred.uid);
        if (s !== undefined) byUid[cred.uid] = s;
      }
    }

    return c.json({
      pool: stats,
      ...(byUid ? { byUid } : {}),
    });
  });

  // GET /admin/health — alias of /healthz but under admin namespace
  app.get("/admin/health", (c) => {
    const startedAt = deps.startedAt ?? Date.now();
    return c.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      version: "0.1.0",
    });
  });

  // POST /admin/auth/passkey -> 501 stub
  app.post("/admin/auth/passkey", (c) => passkeyNotImplemented(c));
  // Also support GET for discovery
  app.get("/admin/auth/passkey", (c) => passkeyNotImplemented(c));
  // POST /admin/checkin/:uid -> delegates to scheduler if present else 501
  app.post("/admin/checkin/:uid", async (c) => {
    if (!store) return c.json({ error: { code: "UNAVAILABLE", message: "store not configured" } }, 503);
    const uid = c.req.param("uid");
    if (!deps.checkinScheduler || typeof deps.checkinScheduler.trigger !== "function") {
      return c.json({ error: { code: "NOT_IMPLEMENTED", message: "check-in scheduler not enabled" } }, 501);
    }
    const cred = store.get(uid);
    if (!cred) {
      return c.json({ error: { code: "NOT_FOUND", message: `credential ${uid} not found` } }, 404);
    }
    try {
      const result = await deps.checkinScheduler.trigger(uid);
      return c.json({ ok: true, uid, result: result ?? null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, uid }, "checkin trigger failed");
      return c.json({ error: { code: "CHECKIN_FAILED", message: msg } }, 502);
    }
  });

  // GET /admin/usage — recent request logs with crb- IDs, tokens, cache hit/miss
  // Query: ?range=today|7d|30d|1h|6h|24h|yesterday|all  (default all)
  // Auth is via adminAuth middleware mounted in src/app.ts (timingSafeEqual); this handler assumes it.
  app.get("/admin/usage", (c) => {
    const range = c.req.query("range") ?? "all";
    const data = listUsage(range);
    return c.json({ data });
  });

  // GET /admin/usage/quota — billing packages (refill + bonus packs) for one
  // credential. ?uid=<uid> optional; defaults to the first stored credential.
  app.get("/admin/usage/quota", async (c) => {
    if (!store) return c.json({ error: { code: "UNAVAILABLE", message: "store not configured" } }, 503);
    const uid = c.req.query("uid") ?? store.list()[0]?.uid;
    const cred = uid ? store.get(uid) : null;
    if (!cred) return c.json({ error: { code: "NOT_FOUND", message: "no credential available" } }, 404);
    try {
      const quota = await fetchUsageQuota(cred, {
        apiBase: deps.config.apiBase,
        logger,
      });
      return c.json({ uid: cred.uid, ...quota });
    } catch (err) {
      if (err instanceof QuotaError) {
        const status = err.status >= 400 && err.status < 500 ? (err.status as 401 | 403 | 404) : (502 as const);
        return c.json({ error: { code: "QUOTA_FAILED", message: err.message } }, status);
      }
      logger.error({ err: String(err), uid: cred.uid }, "quota fetch failed");
      return c.json({ error: { code: "UPSTREAM_ERROR", message: "failed to fetch quota" } }, 502);
    }
  });
}
