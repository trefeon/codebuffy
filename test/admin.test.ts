import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { loadConfig } from "../src/config";
import type { Config } from "../src/config";
import { createLogger } from "../src/logger";
import type { Logger } from "../src/logger";
import { createApp } from "../src/app";
import { adminAuth } from "../src/middleware/admin-auth";
import { mountAdminRoutes } from "../src/admin/routes";
import type { CheckinSchedulerLike } from "../src/admin/routes";
import { isLoopback, parseAdminKeys, passkeyNotImplemented } from "../src/admin/auth";
import type { Credential } from "../src/credentials/types";
import type { CredentialStore } from "../src/credentials/store";
import type { Pool } from "../src/pool/types";
function makeCredential(uid: string, overrides: Partial<Credential> = {}): Credential {
  const now = Date.now();
  const base: Credential = {
    uid,
    label: `label-${uid}`,
    domain: "www.codebuddy.cn",
    apiBase: "https://copilot.tencent.com",
    consoleBase: "https://www.codebuddy.cn",
    auth: {
      accessToken: `access-${uid}`,
      refreshToken: `refresh-${uid}`,
      tokenType: "Bearer",
      expiresAt: now + 3600_000,
      refreshExpiresAt: now + 7200_000,
      capturedAt: now,
      source: "test",
    },
    apiKey: { name: "test", fullKey: `ck_full_${uid}_secret` },
  };
  return { ...base, ...overrides, auth: { ...base.auth, ...(overrides.auth ?? {}) } } as Credential;
}

function makeMemoryStore(initial: Credential[] = []): CredentialStore & { _map: Map<string, Credential> } {
  const map = new Map<string, Credential>();
  for (const c of initial) map.set(c.uid, c);
  return {
    _map: map,
    upsert(cred: Credential) {
      map.set(cred.uid, cred);
    },
    get(uid: string) {
      return map.get(uid) ?? null;
    },
    list() {
      return [...map.values()];
    },
    delete(uid: string) {
      map.delete(uid);
    },
    close() {},
  };
}

function makeMockPool(store: CredentialStore, extra: Record<string, unknown> = {}) {
  return {
    size() {
      return store.list().length;
    },
    getState(uid: string) {
      // simple: return "active" for known uids
      const found = store.get(uid);
      return found ? "active" : undefined;
    },
    getStats() {
      return { size: store.list().length, byState: { active: store.list().length } };
    },
    ...extra,
  };
}

function buildAdminApp(opts: {
  adminKeys?: string[];
  downstreamKeys?: string[];
  creds?: Credential[];
  pool?: { size: () => number; getState?: (uid: string) => string | undefined; getStats?: () => unknown };
  checkinScheduler?: { trigger: (uid: string) => Promise<unknown> } | null;
  useCreateApp?: boolean;
} = {}) {
  const baseConfig = loadConfig({}, () => null);
  // Build mutable config with admin keys (bypass freeze)
  const config: Record<string, unknown> = {
    ...baseConfig,
    adminKeys: opts.adminKeys !== undefined ? opts.adminKeys : ["admin-key-12345678"],
    downstreamApiKeys: opts.downstreamKeys !== undefined ? opts.downstreamKeys : [],
  };
  // Ensure required fields present
  (config as unknown as { port: number }).port = baseConfig.port;
  (config as unknown as { host: string }).host = baseConfig.host;

  const logger = createLogger(baseConfig);
  const store = makeMemoryStore(opts.creds ?? [makeCredential("uid-1"), makeCredential("uid-2")]);
  const pool = opts.pool ?? makeMockPool(store);
  let app: Hono;
  if (opts.useCreateApp) {
    // via createApp wiring — single mount, no manual second mount (would double-register)
    app = createApp({
      config: config as unknown as Config,
      logger: logger as unknown as Logger,
      startedAt: Date.now(),
      pool: pool as unknown as Pool,
      upstream: undefined,
      store: store as unknown as CredentialStore,
      checkinScheduler: opts.checkinScheduler as unknown as CheckinSchedulerLike | null,
    });
  } else {
    app = new Hono();
    app.use("/admin/*", adminAuth(config as unknown as Config));
    mountAdminRoutes(app, {
      config: config as unknown as Config,
      logger: logger as unknown as Logger,
      store: store as unknown as CredentialStore,
      pool: pool as unknown as { size: () => number; getState?: (uid: string) => string | undefined; getStats?: () => unknown },
      checkinScheduler: opts.checkinScheduler ?? null,
      startedAt: Date.now(),
    });
  }

  return { app, store, pool, config, logger };
}

// ---------------------------------------------------------------------------

describe("adminAuth middleware", () => {
  it("401 without key", async () => {
    const { app } = buildAdminApp({ adminKeys: ["admin-key-12345678"] });
    const res = await app.request("/admin/credentials");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("401 with wrong key", async () => {
    const { app } = buildAdminApp({ adminKeys: ["admin-key-12345678"] });
    const res = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer wrong-key-00000000" },
    });
    expect(res.status).toBe(401);
  });

  it("200 with correct admin key", async () => {
    const { app } = buildAdminApp({ adminKeys: ["admin-key-12345678"] });
    const res = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
  });

  it("allows downstream fallback when admin keys empty", async () => {
    const { app } = buildAdminApp({ adminKeys: [], downstreamKeys: ["downstream-key-12345678"] });
    const resBad = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer wrong-key-xxxxxxxx" },
    });
    expect(resBad.status).toBe(401);

    const resOk = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer downstream-key-12345678" },
    });
    expect(resOk.status).toBe(200);
  });

  it("open mode when both empty (warn but allow)", async () => {
    const { app } = buildAdminApp({ adminKeys: [], downstreamKeys: [] });
    const res = await app.request("/admin/credentials");
    // open mode delegates to next — should be 200
    expect(res.status).toBe(200);
  });
});

describe("admin routes via createApp wiring", () => {
  it("via createApp: 401 without key, 200 with key", async () => {
    const { app } = buildAdminApp({ useCreateApp: true, adminKeys: ["admin-key-12345678"] });
    const r1 = await app.request("/admin/credentials");
    expect(r1.status).toBe(401);
    const r2 = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(r2.status).toBe(200);
  });
});

describe("GET /admin/credentials — hides tokens", () => {
  it("list does not leak accessToken/refreshToken/fullKey", async () => {
    const creds = [makeCredential("uid-1"), makeCredential("uid-2")];
    const { app } = buildAdminApp({ creds });
    const res = await app.request("/admin/credentials", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credentials: unknown[] };
    expect(body.credentials).toHaveLength(2);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("access-uid-1");
    expect(raw).not.toContain("refresh-uid-1");
    expect(raw).not.toContain("ck_full_");
    // sanitized fields present
    const first = body.credentials[0] as Record<string, unknown>;
    expect(first["uid"]).toBeDefined();
    expect(first["domain"]).toBe("www.codebuddy.cn");
    expect(first["expiresAt"]).toBeDefined();
  });

  it("single GET hides tokens as well", async () => {
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1")] });
    const res = await app.request("/admin/credentials/uid-1", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { credential: Record<string, unknown> };
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("access-uid-1");
    expect(raw).not.toContain("refresh-uid-1");
    expect(body.credential.uid).toBe("uid-1");
    // include state from pool.getState
    expect(body.credential["state"]).toBe("active");
  });

  it("404 for unknown uid", async () => {
    const { app } = buildAdminApp();
    const res = await app.request("/admin/credentials/not-found", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/credentials/:uid", () => {
  it("delete removes", async () => {
    const { app, store } = buildAdminApp({ creds: [makeCredential("uid-1"), makeCredential("uid-2")] });
    expect(store.list()).toHaveLength(2);
    const del = await app.request("/admin/credentials/uid-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.get("uid-1")).toBeNull();

    const get = await app.request("/admin/credentials/uid-1", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(get.status).toBe(404);
  });

  it("delete 404 for missing", async () => {
    const { app } = buildAdminApp();
    const res = await app.request("/admin/credentials/missing", {
      method: "DELETE",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/pool/state", () => {
  it("reflects mock pool stats and by-uid state", async () => {
    const store = makeMemoryStore([makeCredential("uid-1"), makeCredential("uid-2")]);
    const pool = makeMockPool(store);
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1"), makeCredential("uid-2")], pool });
    const res = await app.request("/admin/pool/state", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pool: { size: number }; byUid: Record<string, string> };
    expect(body.pool.size).toBe(2);
    expect(body.byUid["uid-1"]).toBe("active");
  });

  it("pool/state without getState still returns size", async () => {
    const poolNoState = { size: () => 1 };
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1")], pool: poolNoState });
    const res = await app.request("/admin/pool/state", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pool: { size: number } };
    expect(body.pool.size).toBe(1);
  });
});

describe("GET /admin/health alias", () => {
  it("returns ok", async () => {
    const { app } = buildAdminApp();
    const res = await app.request("/admin/health", {
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });
});

describe("POST /admin/auth/passkey", () => {
  it("returns 501", async () => {
    const { app } = buildAdminApp();
    const res = await app.request("/admin/auth/passkey", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("POST /admin/checkin/:uid", () => {
  it("501 when scheduler absent", async () => {
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1")], checkinScheduler: null });
    const res = await app.request("/admin/checkin/uid-1", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(501);
  });

  it("delegates to scheduler when present", async () => {
    let triggered: string | null = null;
    const scheduler = {
      async trigger(uid: string) {
        triggered = uid;
        return { claimed: true, credits: 42 };
      },
    };
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1")], checkinScheduler: scheduler });
    const res = await app.request("/admin/checkin/uid-1", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(200);
    expect(triggered!).toBe("uid-1");
    const body = (await res.json()) as { ok: boolean; result: { claimed: boolean } };
    expect(body.ok).toBe(true);
    expect(body.result.claimed).toBe(true);
  });

  it("404 when credential missing even with scheduler", async () => {
    const scheduler = { async trigger() {} };
    const { app } = buildAdminApp({ creds: [makeCredential("uid-1")], checkinScheduler: scheduler });
    const res = await app.request("/admin/checkin/uid-999", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key-12345678" },
    });
    expect(res.status).toBe(404);
  });
});

describe("isLoopback helper", () => {
  it("recognizes loopback hosts", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.1:3000")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("LOCALHOST")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("[::1]:3000")).toBe(true);
    expect(isLoopback("127.0.2.5")).toBe(true);
  });
  it("rejects non-loopback", () => {
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.1")).toBe(false);
    expect(isLoopback("example.com")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });
});
describe("parseAdminKeys helper", () => {
  it("parses comma-split and validates length", () => {
    expect(() => parseAdminKeys("a,b")).toThrow();
    expect(parseAdminKeys("admin-key-12345678, second-key-12345678")).toEqual([
      "admin-key-12345678",
      "second-key-12345678",
    ]);
    expect(parseAdminKeys("")).toEqual([]);
    expect(parseAdminKeys(undefined)).toEqual([]);
  });
});

describe("passkeyNotImplemented export", () => {
  it("is callable as Hono handler (501)", async () => {
    const app = new Hono();
    app.post("/test", (c) => passkeyNotImplemented(c));
    const res = await app.request("/test", { method: "POST" });
    expect(res.status).toBe(501);
  });
});
