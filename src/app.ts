import { Hono } from "hono";
import type { Config } from "./config";
import type { Logger } from "./logger";
import type { Pool } from "./pool/types";
import type { UpstreamClient } from "./upstream/client";
import { downstreamAuth } from "./middleware/downstream-auth";
import { mountOpenAIRoutes } from "./routes/openai";
import { mountAnthropicRoutes } from "./routes/anthropic";

const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  logger: Logger;
  startedAt: number;
  pool?: Pool;
  upstream?: UpstreamClient;
}

/**
 * Factory (not a singleton) so tests can build isolated instances —
 * the create_app pattern identified as best-in-class in research/04 §3.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

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

  app.get("/readyz", (c) =>
    c.json({
      status: "ok",
      checks: {
        config: true, // config is validated at startup; process would not be serving otherwise
        pool: deps.pool ? deps.pool.size() > 0 : false,
        upstream: Boolean(deps.upstream),
      },
    }),
  );
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
  }

  return app;
}
