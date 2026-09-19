import { Hono } from "hono";
import type { Config } from "./config";
import type { Logger } from "./logger";
import type { Pool } from "./pool/types";
import type { CredentialState } from "./pool/state";
import type { UpstreamClient } from "./upstream/client";
import type { CredentialStore } from "./credentials/store";
import type { Credential } from "./credentials/types";
import { downstreamAuth } from "./middleware/downstream-auth";
import { adminAuth } from "./middleware/admin-auth";
import { metricsMiddleware } from "./observability/middleware";
import { mountMetricsRoutes } from "./routes/metrics";
import { mountAdminRoutes, type CheckinSchedulerLike } from "./admin/routes";
import { mountOpenAIRoutes } from "./routes/openai";
import { mountAnthropicRoutes } from "./routes/anthropic";
import { mountResponsesRoutes } from "./routes/responses";
import { mountCodexRoutes } from "./routes/codex";

const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  logger: Logger;
  startedAt: number;
  pool?: Pool & { getStats?: () => Record<CredentialState, number> };
  upstream?: UpstreamClient;
  /** Forced token refresh for live 401/403 recovery (RefreshService in prod). */
  refresh?: { refreshNow(uid: string): Promise<Credential> };
  store?: CredentialStore & {
    isEncrypted?: () => boolean;
    listExpiringSoon?: (skewMs?: number) => unknown[];
  };
  checkinScheduler?: CheckinSchedulerLike | null;
}

// ---- G10 provider registry (additive; existing mount callsites unchanged) ----

export interface DialectEntry {
  dialect: string;
  routes: string[];
}

/** Every downstream dialect the gateway serves and the routes each one owns. */
export const PROVIDER_REGISTRY: DialectEntry[] = [
  { dialect: "openai", routes: ["/v1/chat/completions", "/v1/models"] },
  { dialect: "anthropic", routes: ["/v1/messages"] },
  { dialect: "responses", routes: ["/v1/responses"] },
];

/** Dialects actually mounted for these deps (pool+upstream gate the /v1 plane). */
export function getMountedDialects(deps: AppDeps): DialectEntry[] {
  return deps.pool && deps.upstream ? PROVIDER_REGISTRY : [];
}

/**
 * G10: assert every mounted dialect has an executor at startup — logs the
 * registry and throws otherwise so a half-wired provider plane can never
 * serve. All three dialects execute through the shared upstream client, so
 * the executor check is `upstream.streamChat` presence.
 */
export function assertProviderRegistry(deps: AppDeps): string[] {
  const mounted = getMountedDialects(deps);
  if (mounted.length === 0) {
    deps.logger.info("provider registry: no dialects mounted (pool/upstream absent)");
    return [];
  }
  const upstream = deps.upstream as unknown as { streamChat?: unknown } | undefined;
  if (!upstream || typeof upstream.streamChat !== "function") {
    const names = mounted.map((d) => d.dialect);
    deps.logger.error({ missing: names }, "provider registry: mounted dialect(s) without executor");
    throw new Error(`provider registry: mounted dialect(s) without executor: ${names.join(", ")}`);
  }
  const names = mounted.map((d) => d.dialect);
  deps.logger.info({ dialects: names }, "provider registry ready");
  return names;
}

/**
 * Factory (not a singleton) so tests can build isolated instances —
 * the create_app pattern identified as best-in-class in research/04 §3.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // G10: fail closed when a mounted dialect has no executor.
  assertProviderRegistry(deps);

  // Admin UI static — serve before auth so HTML loads without key, JS will prompt for key
  app.get("/admin/", async (c) => {
    try {
      const file = Bun.file("src/admin/ui/index.html");
      if (!(await file.exists())) return c.notFound();
      return c.html(await file.text());
    } catch {
      return c.notFound();
    }
  });
  app.get("/admin/ui/*", async (c) => {
    const raw = c.req.path.replace(/^\/admin\/ui\//, "");
    let filePath: string;
    try {
      filePath = decodeURIComponent(raw);
    } catch {
      return c.notFound();
    }
    // allow only known static — prevents path traversal and arbitrary src read
    const allowed: Record<string, true> = {
      "app.js": true,
      "style.css": true,
      "pages/dashboard.js": true,
      "pages/credentials.js": true,
      "pages/api-keys.js": true,
      "pages/console.js": true,
      "pages/usage.js": true,
      "pages/debug.js": true,
      "pages/settings.js": true,
      "pages/login.js": true,
    };
    if (
      filePath.includes("..") ||
      filePath.includes("\\") ||
      filePath.startsWith("/") ||
      !allowed[filePath]
    )
      return c.notFound();
    try {
      const file = Bun.file(`src/admin/ui/${filePath}`);
      if (!(await file.exists())) return c.notFound();
      const isJs = filePath.endsWith(".js");
      const content = await file.text();
      return new Response(content, {
        headers: {
          "Content-Type": isJs ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch {
      return c.notFound();
    }
  });
  // Metrics first so every request is counted, including /healthz & /readyz.
  app.use("*", metricsMiddleware());
  mountMetricsRoutes(app, { config: deps.config });

  app.onError((err, c) => {
    deps.logger.error({ err: err.stack ?? (err as Error).message }, "unhandled error");
    // Full error details stay in the log; clients get a generic envelope.
    return c.json({ error: { code: "INTERNAL", message: "internal server error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND", message: "no such route" } }, 404));

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      version: VERSION,
    }),
  );

  app.get("/readyz", (c) => {
    const poolSize = deps.pool?.size() ?? 0;
    const byState =
      deps.pool?.getStats?.() ??
      (poolSize > 0 ? ({ active: poolSize } as Record<CredentialState, number>) : ({} as Record<CredentialState, number>));
    const expiringSoon = deps.store?.listExpiringSoon?.()?.length ?? 0;
    const encrypted = deps.store?.isEncrypted?.() ?? Boolean(deps.config.encryptionKey);

    return c.json({
      status: "ok",
      version: VERSION,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      checks: {
        config: true, // config is validated at startup; process would not be serving otherwise
        pool: poolSize > 0,
        upstream: Boolean(deps.upstream),
      },
      pool: {
        size: poolSize,
        byState,
        expiringSoon,
      },
      store: { encrypted },
      upstream: { configured: Boolean(deps.upstream) },
    });
  });

  // Admin plane — available even when pool is empty (health/pool/state still useful).
  // Gated by adminAuth which handles adminKeys -> downstream fallback -> open mode.
  if (deps.config.adminEnabled !== false) {
    app.use("/admin/*", adminAuth(deps.config, deps.logger));
    mountAdminRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      store: deps.store ?? null,
      pool: deps.pool,
      checkinScheduler: deps.checkinScheduler ?? undefined,
      startedAt: deps.startedAt,
    });
  }

  // OpenAI-compatible API — only mounted when pool+upstream are provided.
  // Health probes stay open; /v1/* is gated by downstream API keys (if configured).
  if (deps.pool && deps.upstream) {
    app.use("/v1/*", downstreamAuth(deps.config));
    mountOpenAIRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
      refresh: deps.refresh,
    });
    mountAnthropicRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
      refresh: deps.refresh,
    });
    mountResponsesRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
      refresh: deps.refresh,
    });
    app.use("/codex/*", downstreamAuth(deps.config));
    mountCodexRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
      refresh: deps.refresh,
    });
  }

  return app;
}
