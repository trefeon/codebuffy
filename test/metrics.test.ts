import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import {
  reset,
  renderMetrics,
  incRequestsTotal,
  incUpstreamErrorsTotal,
  setCredentialsTotal,
  setPoolState,
  setPoolStates,
  observeRequestDuration,
} from "../src/observability/metrics";
import { metricsMiddleware } from "../src/observability/middleware";
import { mountMetricsRoutes } from "../src/routes/metrics";

function silentLogger() {
  const config = loadConfig({}, () => null);
  return createLogger({ ...config, logLevel: "silent" });
}

beforeEach(() => {
  reset();
});

// ---- registry unit tests ----

describe("metrics registry", () => {
  it("renders HELP and TYPE lines and empty gauges", () => {
    const out = renderMetrics();
    expect(out).toContain("# HELP codebuffy_requests_total");
    expect(out).toContain("# TYPE codebuffy_requests_total counter");
    expect(out).toContain("# HELP codebuffy_upstream_errors_total");
    expect(out).toContain("# TYPE codebuffy_upstream_errors_total counter");
    expect(out).toContain("# HELP codebuffy_credentials_total");
    expect(out).toContain("# TYPE codebuffy_credentials_total gauge");
    expect(out).toContain("# HELP codebuffy_pool_state");
    expect(out).toContain("# TYPE codebuffy_pool_state gauge");
    expect(out).toContain("# HELP codebuffy_request_duration_seconds");
    expect(out).toContain("# TYPE codebuffy_request_duration_seconds histogram");
    // histogram buckets must be present even with no observations
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="0.005"} 0');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="+Inf"} 0');
    expect(out).toContain("codebuffy_request_duration_seconds_sum 0");
    expect(out).toContain("codebuffy_request_duration_seconds_count 0");
  });

  it("incRequestsTotal and render includes labels", () => {
    incRequestsTotal({ route: "/v1/chat/completions", method: "POST", status: 200 }, 2);
    incRequestsTotal({ route: "/v1/chat/completions", method: "POST", status: 200 }, 1);
    incRequestsTotal({ route: "/healthz", method: "GET", status: 200 });
    const out = renderMetrics();
    expect(out).toContain('codebuffy_requests_total{route="/v1/chat/completions",method="POST",status="200"} 3');
    expect(out).toContain('codebuffy_requests_total{route="/healthz",method="GET",status="200"} 1');
  });

  it("incUpstreamErrorsTotal aggregates by code", () => {
    incUpstreamErrorsTotal(429);
    incUpstreamErrorsTotal("429", 2);
    incUpstreamErrorsTotal(500);
    const out = renderMetrics();
    expect(out).toContain('codebuffy_upstream_errors_total{code="429"} 3');
    expect(out).toContain('codebuffy_upstream_errors_total{code="500"} 1');
  });

  it("credentials_total gauge and pool_state gauge", () => {
    setCredentialsTotal(5);
    setPoolState("active", 3);
    setPoolStates({ cooldown: 1, banned: 1 });
    const out = renderMetrics();
    expect(out).toContain("codebuffy_credentials_total 5");
    expect(out).toContain('codebuffy_pool_state{state="active"} 3');
    expect(out).toContain('codebuffy_pool_state{state="banned"} 1');
    expect(out).toContain('codebuffy_pool_state{state="cooldown"} 1');
  });

  it("histogram observe increments cumulative buckets, sum and count", () => {
    observeRequestDuration(0.02); // <=0.025 and larger
    observeRequestDuration(0.3); // <=0.5 and larger
    observeRequestDuration(10); // >5 only +Inf
    const out = renderMetrics();
    // After 3 observes, count=3 sum ~10.32
    expect(out).toContain("codebuffy_request_duration_seconds_count 3");
    expect(out).toMatch(/codebuffy_request_duration_seconds_sum 10\./);
    // cumulative: le=0.01 should be 0 (no observation <=0.01? first is 0.02, so actually 0)
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="0.01"} 0');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="0.025"} 1');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="0.05"} 1');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="0.5"} 2');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="5"} 2');
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="+Inf"} 3');
  });

  it("reset clears all state", () => {
    incRequestsTotal({ route: "/x", method: "GET", status: 200 });
    incUpstreamErrorsTotal(500);
    setCredentialsTotal(9);
    setPoolState("active", 9);
    observeRequestDuration(0.1);
    reset();
    const out = renderMetrics();
    expect(out).not.toContain('codebuffy_requests_total{route="/x"');
    expect(out).not.toContain('codebuffy_upstream_errors_total{code="500"} 1');
    expect(out).toContain("codebuffy_credentials_total 0");
    expect(out).toContain('codebuffy_request_duration_seconds_bucket{le="+Inf"} 0');
    expect(out).toContain("codebuffy_request_duration_seconds_count 0");
  });
});

// ---- middleware tests ----

describe("metricsMiddleware", () => {
  it("counts requests, observes duration, sets X-Request-Id", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware());
    app.get("/hello", (c) => c.text("hi"));
    app.get("/healthz", (c) => c.text("ok"));
    app.get("/metrics", (c) => c.text("metrics"));

    const res1 = await app.request("/hello");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Request-Id")).toBeTruthy();

    // reused request id echoed
    const res2 = await app.request("/hello", {
      headers: { "X-Request-Id": "test-id-123" },
    });
    expect(res2.headers.get("X-Request-Id")).toBe("test-id-123");

    // healthz & metrics still counted in requests_total
    await app.request("/healthz");
    await app.request("/metrics");

    const out = renderMetrics();
    // route label may be normalized via routePath or path; both contain /hello
    expect(out).toMatch(/codebuffy_requests_total\{[^}]*route="\/hello"[^}]*\} 2/);
    expect(out).toMatch(/codebuffy_requests_total\{[^}]*route="\/healthz"[^}]*\} 1/);
    expect(out).toMatch(/codebuffy_requests_total\{[^}]*route="\/metrics"[^}]*\} 1/);

    // histogram should have counted /hello but skipped /healthz and /metrics
    // 2 hello requests => count 2, but healthz/metrics not observed
    expect(out).toContain("codebuffy_request_duration_seconds_count 2");
  });

  it("records status code dimension", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware());
    app.get("/boom", (c) => c.text("err", 500));

    await app.request("/boom");
    const out = renderMetrics();
    expect(out).toMatch(/codebuffy_requests_total\{[^}]*route="\/boom"[^}]*status="500"[^}]*\} 1/);
  });
});

// ---- /metrics endpoint tests ----

describe("GET /metrics endpoint", () => {
  function buildAppWithMetrics(overrides: Record<string, unknown> = {}) {
    const base = loadConfig({}, () => null);
    const config = { ...base, ...overrides } as unknown as typeof base & { metricsEnabled?: boolean };
    const logger = silentLogger();
    const app = createApp({ config, logger, startedAt: Date.now() - 1000 });
    // mount metrics route like production wiring will do (middleware not required for this slice, but add for completeness)
    app.use("*", metricsMiddleware());
    mountMetricsRoutes(app, { config });
    return app;
  }

  it("returns 200 text/plain with HELP/TYPE and counters after requests", async () => {
    const app = buildAppWithMetrics({ metricsEnabled: true });

    // generate traffic so counters are non-empty
    await app.request("/healthz");
    await app.request("/nonexistent");

    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("# HELP codebuffy_requests_total");
    expect(body).toContain("# TYPE codebuffy_requests_total counter");
    // at least healthz was counted
    expect(body).toMatch(/codebuffy_requests_total\{/);
  });

  it("returns 404 when metricsEnabled is false", async () => {
    const app = buildAppWithMetrics({ metricsEnabled: false });
    const res = await app.request("/metrics");
    expect(res.status).toBe(404);
  });

  it("is reachable without auth even when downstream keys configured", async () => {
    const app = buildAppWithMetrics({ metricsEnabled: true, downstreamApiKeys: ["secret-key-12345"] } as unknown as Record<string, unknown>);
    // /metrics is mounted outside /v1/* auth boundary
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
  });

  it("exposes upstream and pool gauges after setting them", async () => {
    const app = buildAppWithMetrics();
    setCredentialsTotal(2);
    setPoolState("active", 2);
    incUpstreamErrorsTotal(503, 1);

    const res = await app.request("/metrics");
    const body = await res.text();
    expect(body).toContain("codebuffy_credentials_total 2");
    expect(body).toContain('codebuffy_pool_state{state="active"} 2');
    expect(body).toContain('codebuffy_upstream_errors_total{code="503"} 1');
  });
});
