import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import type { Logger } from "../src/logger";
import type { Credential } from "../src/credentials/types";
import { UpstreamClient } from "../src/upstream/client";
import type { UpstreamChunk } from "../src/upstream/types";
import { UpstreamError } from "../src/upstream/errors";

const SECRET = "SECRET-BODY-9f8e7d6c5b4a";

function makeCred(): Credential {
  const now = Date.now();
  return {
    uid: "uid-secret-safe",
    label: "secret-safe",
    domain: "copilot.tencent.com",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: "at-secret-safe",
      refreshToken: "rt-secret-safe",
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
  } as Credential;
}

/** Upstream whose failure body carries a canary secret in UpstreamError.raw. */
class SecretBodyUpstream extends UpstreamClient {
  constructor() {
    const config = loadConfig({}, () => null);
    super(config, createLogger({ ...config, logLevel: "silent" }) as never);
  }
  override async fetchModels(): Promise<unknown> {
    throw new UpstreamError(500, "boom", 500, false, { rawBody: SECRET, token: SECRET });
  }
  override async *streamChat(): AsyncIterable<UpstreamChunk> {
    throw new UpstreamError(500, "boom", 500, false, { rawBody: SECRET });
  }
}

describe("secret-safe error logs", () => {
  it("models-fallback warn carries code/message only — no upstream body or secret", async () => {
    const seen: unknown[] = [];
    const capture = {
      info: () => { },
      debug: () => { },
      trace: () => { },
      fatal: () => { },
      warn: (rec: unknown) => {
        seen.push(rec);
      },
      error: (rec: unknown) => {
        seen.push(rec);
      },
      child: () => capture,
    } as unknown as Logger;
    const config = loadConfig({}, () => null);
    const app = createApp({
      config,
      logger: capture,
      startedAt: Date.now(),
      pool: { pick: async () => makeCred(), size: () => 1 },
      upstream: new SecretBodyUpstream() as never,
    });
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200); // fallback catalog served
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });
});
