import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";

function buildApp() {
  const config = loadConfig({}, () => null);
  const logger = createLogger({ ...config, logLevel: "silent" });
  return createApp({ config, logger, startedAt: Date.now() - 5_000 });
}

describe("GET /healthz", () => {
  it("returns ok with uptime and version", async () => {
    const res = await buildApp().request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(Number(body.uptimeSeconds)).toBeGreaterThanOrEqual(5);
  });
});

describe("GET /readyz", () => {
  it("reports passing checks", async () => {
    const res = await buildApp().request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: Record<string, boolean> };
    expect(body.status).toBe("ok");
    expect(body.checks.config).toBe(true);
  });
});

describe("unknown routes", () => {
  it("return a JSON error envelope", async () => {
    const res = await buildApp().request("/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });
});
