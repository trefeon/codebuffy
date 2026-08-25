import type { Hono } from "hono";
import type { Config } from "../config";
import { renderMetrics } from "../observability/metrics";

export interface MetricsDeps {
  config: Config;
}

export function mountMetricsRoutes(app: Hono, deps: MetricsDeps): void {
  app.get("/metrics", (c) => {
    const maybeConfig = deps.config as unknown as { metricsEnabled?: boolean };
    if (maybeConfig.metricsEnabled === false) {
      return c.text("not found", 404);
    }

    const body = renderMetrics();
    // Prometheus text exposition version 0.0.4
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(body, 200);
  });
}
