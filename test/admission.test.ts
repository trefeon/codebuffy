import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteCredentialStore } from "../src/credentials/store";
import type { Credential } from "../src/credentials/types";
import type { RefreshService } from "../src/credentials/refresh";
import type { UpstreamClient } from "../src/upstream/client";
import type { Logger } from "../src/logger";
import {
  AdmissionRejectedError,
  DEFAULT_MAX_INFLIGHT,
  DEFAULT_MAX_QUEUE,
  RoundRobinPool,
} from "../src/pool/round-robin";
import type { AdmissionOptions } from "../src/pool/round-robin";
import { assertProviderRegistry, getMountedDialects } from "../src/app";
import type { AppDeps } from "../src/app";
import { renderMetrics, reset } from "../src/observability/metrics";
import { startSpan } from "../src/observability/tracing";

function makeCredential(uid: string): Credential {
  const now = Date.now();
  return {
    uid,
    label: `label-${uid}`,
    domain: "https://api.example.com",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `AT_${uid}`,
      refreshToken: `RT_${uid}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
  } as Credential;
}

function makeLogger(): Logger {
  return {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
  } as unknown as Logger;
}

const stores: SqliteCredentialStore[] = [];

afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch { }
  }
});

function makePool(admission?: AdmissionOptions): RoundRobinPool {
  const store = new SqliteCredentialStore(":memory:", null);
  stores.push(store);
  return new RoundRobinPool(
    store,
    {} as unknown as RefreshService,
    makeLogger(),
    admission ? { admission } : {},
  );
}

beforeEach(() => {
  reset();
});

describe("admission defaults", () => {
  it("exposes conservative in-module defaults", () => {
    expect(DEFAULT_MAX_INFLIGHT).toBe(64);
    expect(DEFAULT_MAX_QUEUE).toBe(128);
    expect(makePool().getAdmissionStats()).toEqual({
      inflight: 0,
      queued: 0,
      maxInflight: 64,
      maxQueue: 128,
    });
  });
});

describe("admission semaphore", () => {
  it("grants up to maxInflight then queues FIFO", async () => {
    const pool = makePool({ maxInflight: 1, maxQueue: 2 });
    await pool.acquireAdmission();
    expect(pool.getAdmissionStats()).toEqual({
      inflight: 1,
      queued: 0,
      maxInflight: 1,
      maxQueue: 2,
    });

    const order: string[] = [];
    const b = pool.acquireAdmission().then(() => {
      order.push("b");
    });
    const c = pool.acquireAdmission().then(() => {
      order.push("c");
    });
    // Queueing is synchronous up to the wait point: nothing granted yet.
    expect(order).toEqual([]);
    expect(pool.getAdmissionStats().queued).toBe(2);

    pool.releaseAdmission();
    await b;
    expect(order).toEqual(["b"]);
    expect(pool.getAdmissionStats()).toEqual({
      inflight: 1,
      queued: 1,
      maxInflight: 1,
      maxQueue: 2,
    });

    pool.releaseAdmission();
    await c;
    expect(order).toEqual(["b", "c"]);
    pool.releaseAdmission();
    expect(pool.getAdmissionStats()).toEqual({
      inflight: 0,
      queued: 0,
      maxInflight: 1,
      maxQueue: 2,
    });
  });

  it("rejects beyond the bounded queue with 503 + Retry-After and counts the metric", async () => {
    const pool = makePool({ maxInflight: 1, maxQueue: 1, retryAfterSeconds: 7 });
    await pool.acquireAdmission();
    const queued = pool.acquireAdmission();
    const rejected = pool.acquireAdmission();
    const err = await rejected.then(
      () => {
        throw new Error("expected AdmissionRejectedError");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdmissionRejectedError);
    const admissionErr = err as AdmissionRejectedError;
    expect(admissionErr.status).toBe(503);
    expect(admissionErr.retryAfter).toBe(7);
    expect(admissionErr.toHeaders()).toEqual({ "Retry-After": "7" });
    expect(renderMetrics()).toContain('codebuffy_upstream_errors_total{code="admission_saturated"} 1');

    pool.releaseAdmission();
    await queued;
    pool.releaseAdmission();
    expect(pool.getAdmissionStats().inflight).toBe(0);
  });

  it("withAdmission releases on success and on error", async () => {
    const pool = makePool({ maxInflight: 1, maxQueue: 0 });
    await expect(pool.withAdmission(async () => 42)).resolves.toBe(42);
    expect(pool.getAdmissionStats().inflight).toBe(0);
    await expect(
      pool.withAdmission(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(pool.getAdmissionStats().inflight).toBe(0);
  });

  it("abort while queued frees the queue slot", async () => {
    const pool = makePool({ maxInflight: 1, maxQueue: 1 });
    await pool.acquireAdmission();
    const ctl = new AbortController();
    const pending = pool.acquireAdmission(ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toThrow();
    expect(pool.getAdmissionStats().queued).toBe(0);

    // Slot freed: a fresh waiter queues instead of rejecting.
    const waiter = pool.acquireAdmission();
    expect(pool.getAdmissionStats().queued).toBe(1);
    pool.releaseAdmission();
    await waiter;
    pool.releaseAdmission();
    expect(pool.getAdmissionStats().inflight).toBe(0);
  });

  it("release without acquire is a safe no-op", () => {
    const pool = makePool({ maxInflight: 1, maxQueue: 1 });
    pool.releaseAdmission();
    expect(pool.getAdmissionStats()).toEqual({
      inflight: 0,
      queued: 0,
      maxInflight: 1,
      maxQueue: 1,
    });
  });
});

describe("AdmissionRejectedError", () => {
  it("carries status, Retry-After and a JSON envelope", () => {
    const err = new AdmissionRejectedError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AdmissionRejectedError");
    expect(err.status).toBe(503);
    expect(err.retryAfter).toBe(1);
    expect(err.toHeaders()).toEqual({ "Retry-After": "1" });
    expect(err.toJSON()).toEqual({
      error: {
        message: "server saturated: admission queue full",
        type: "server_error",
        code: "ADMISSION_SATURATED",
      },
    });
  });
});

describe("G10 provider registry", () => {
  function depsWith(overrides: Partial<AppDeps>): AppDeps {
    return {
      config: {} as AppDeps["config"],
      logger: makeLogger(),
      startedAt: Date.now(),
      ...overrides,
    };
  }

  it("mounts nothing without pool/upstream", () => {
    expect(getMountedDialects(depsWith({}))).toEqual([]);
    expect(assertProviderRegistry(depsWith({}))).toEqual([]);
  });

  it("asserts all three dialects when pool+upstream are wired", () => {
    const upstream = {
      streamChat() {
        throw new Error("not used");
      },
    } as unknown as UpstreamClient;
    expect(assertProviderRegistry(depsWith({ pool: makePool(), upstream }))).toEqual([
      "openai",
      "anthropic",
      "responses",
    ]);
  });

  it("logs and throws when a mounted dialect has no executor", () => {
    const errors: unknown[] = [];
    const logger = {
      ...makeLogger(),
      error: (obj: unknown) => {
        errors.push(obj);
      },
    } as unknown as Logger;
    const deps: AppDeps = {
      config: {} as AppDeps["config"],
      logger,
      startedAt: Date.now(),
      pool: makePool(),
      upstream: {} as unknown as UpstreamClient,
    };
    expect(() => assertProviderRegistry(deps)).toThrow("without executor");
    expect(errors.length).toBe(1);
  });
});

describe("G3 fail-closed probe", () => {
  it("hasEncryptedRows tracks encrypted rows only", () => {
    const plain = new SqliteCredentialStore(":memory:", null);
    stores.push(plain);
    expect(plain.hasEncryptedRows()).toBe(false);
    plain.upsert(makeCredential("legacy"));
    expect(plain.hasEncryptedRows()).toBe(false);
    expect(plain.get("legacy")?.uid).toBe("legacy");

    const key = randomBytes(32);
    const enc = new SqliteCredentialStore(":memory:", key);
    stores.push(enc);
    expect(enc.hasEncryptedRows()).toBe(false);
    enc.upsert(makeCredential("secret"));
    expect(enc.hasEncryptedRows()).toBe(true);
    expect(enc.get("secret")?.uid).toBe("secret");
  });

  it("plaintext legacy rows migrate when a key is added", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codebuffy-admission-"));
    const dbPath = path.join(dir, "legacy.db");
    const before = new SqliteCredentialStore(dbPath, null);
    before.upsert(makeCredential("legacy-row"));
    before.close();

    const key = randomBytes(32);
    const after = new SqliteCredentialStore(dbPath, key);
    stores.push(after);
    expect(after.hasEncryptedRows()).toBe(false);
    expect(after.get("legacy-row")?.uid).toBe("legacy-row");
    after.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly hold the WAL handle after close; tmpdir reaps it.
    }
  });
});

describe("G4 span helpers", () => {
  it("startSpan never throws without OTel installed", () => {
    const span = startSpan("GET /healthz", { "http.method": "GET" });
    span.setAttribute("http.status_code", 200);
    span.recordException(new Error("boom"));
    span.end({ code: 2, message: "boom" });
    span.end();
    expect(typeof span.end).toBe("function");
  });
});
