import { Hono } from "hono";
import type { Config } from "./config";
import type { Logger } from "./logger";
import type { Pool } from "./pool/types";
import type { CredentialState } from "./pool/state";
import type { UpstreamClient } from "./upstream/client";
import type { CredentialStore } from "./credentials/store";
import { downstreamAuth } from "./middleware/downstream-auth";
import { adminAuth } from "./middleware/admin-auth";
import { metricsMiddleware } from "./observability/middleware";
import { mountMetricsRoutes } from "./routes/metrics";
import { mountAdminRoutes, type CheckinSchedulerLike } from "./admin/routes";
import { mountOpenAIRoutes } from "./routes/openai";
import { mountAnthropicRoutes } from "./routes/anthropic";
import { mountResponsesRoutes } from "./routes/responses";

const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  logger: Logger;
  startedAt: number;
  pool?: Pool & { getStats?: () => Record<CredentialState, number> };
  upstream?: UpstreamClient;
  store?: CredentialStore & {
    isEncrypted?: () => boolean;
    listExpiringSoon?: (skewMs?: number) => unknown[];
  };
  checkinScheduler?: CheckinSchedulerLike | null;
}

/**
 * Factory (not a singleton) so tests can build isolated instances —
 * the create_app pattern identified as best-in-class in research/04 §3.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

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
  app.get("/admin/ui/:file", async (c) => {
    const fileName = c.req.param("file");
    if (!fileName || fileName.includes("..") || fileName.includes("/") || fileName.includes("\\")) {
      return c.notFound();
    }
    const allowed: Record<string, true> = { "app.js": true, "style.css": true };
    if (!allowed[fileName]) return c.notFound();
    try {
      const file = Bun.file(`src/admin/ui/${fileName}`);
      if (!(await file.exists())) return c.notFound();
      const isJs = fileName.endsWith(".js");
      const content = await file.text();
      const contentType = isJs ? "application/javascript" : "text/css";
      return new Response(content, { headers: { "Content-Type": contentType } });
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
    });
    mountAnthropicRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
    });
    mountResponsesRoutes(app, {
      config: deps.config,
      logger: deps.logger,
      pool: deps.pool,
      upstream: deps.upstream,
    });
  }

  return app;
}
