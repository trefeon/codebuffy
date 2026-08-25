import type { MiddlewareHandler } from "hono";
import { incRequestsTotal, observeRequestDuration } from "./metrics";

const SKIP_HISTOGRAM = new Set<string>(["/metrics", "/healthz"]);

export function metricsMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();

    // X-Request-Id: echo incoming or generate
    let requestId = c.req.header("x-request-id") ?? c.req.header("X-Request-Id");
    if (!requestId) {
      requestId = crypto.randomUUID();
    }

    try {
      await next();
    } finally {
      const durationSec = (performance.now() - start) / 1000;

      // Hono exposes the matched route pattern via c.req.routePath in newer versions;
      // fall back to c.req.path for compatibility.
      const maybeReq = c.req as unknown as { routePath?: string };
      const route = maybeReq.routePath ?? c.req.path;
      const method = c.req.method;
      const status = c.res.status;

      incRequestsTotal({ route, method, status });

      const pathForSkip = c.req.path;
      const routeForSkip = route;
      if (!SKIP_HISTOGRAM.has(pathForSkip) && !SKIP_HISTOGRAM.has(routeForSkip)) {
        observeRequestDuration(durationSec);
      }

      // Set response header (preserves incoming id, supplies generated one)
      c.header("X-Request-Id", requestId);
    }
  };
}
