import { Hono } from "hono";
import type { Config } from "./config";
import type { Logger } from "./logger";

const VERSION = "0.1.0";

export interface AppDeps {
  config: Config;
  logger: Logger;
  startedAt: number;
}

/**
 * Factory (not a singleton) so tests can build isolated instances —
 * the create_app pattern identified as best-in-class in research/04 §3.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    deps.logger.error({ err: err.stack ?? err.message }, "unhandled error");
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
        // FUTURE(M1): credentials store reachable
        // FUTURE(M5): pool has active credentials
      },
    }),
  );

  return app;
}
