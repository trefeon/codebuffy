import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { registerShutdown } from "./shutdown";
import { SqliteCredentialStore } from "./credentials/store";
import { loadEncryptionKey } from "./credentials/crypto";
import { RefreshService } from "./credentials/refresh";
import { UpstreamClient } from "./upstream/client";
import { RoundRobinPool } from "./pool/round-robin";
import { StateMachine } from "./pool/state";
import { CacheAffinity } from "./pool/affinity";
import { CircuitBreaker } from "./pool/breaker";
import { CheckinScheduler } from "./checkin/scheduler";
import { isLoopback } from "./admin/auth";
import { importPoolDir } from "./credentials/file-importer";
import { setCredentialsTotal, setPoolStates } from "./observability/metrics";
import { initTracing } from "./observability/tracing";

const config = loadConfig();
const logger = createLogger(config);
initTracing(config, logger);

// Encryption at rest — validate key at startup, fail closed on bad format
let encryptionKey: Buffer | null = null;
if (config.encryptionKey) {
  try {
    encryptionKey = loadEncryptionKey(config.encryptionKey);
  } catch (err) {
    logger.error({ err: (err as Error).message }, "invalid CODEBUFFY_ENCRYPTION_KEY");
    throw err;
  }
}

// Credential store (WAL, encrypted_data migration)
const store = new SqliteCredentialStore(config.dbPath, encryptionKey);
logger.info({ encrypted: store.isEncrypted() }, "credential store ready");

// Best-effort import of pool files produced by scripts/onboard-account.mjs.
// Awaited before pool construction so startup log reflects actual size.
try {
  const { imported, skipped } = await importPoolDir("data/pool", store, logger);
  if (imported > 0 || skipped > 0) {
    logger.info({ imported, skipped }, "pool dir import complete");
  }
} catch (err) {
  logger.warn({ err }, "pool dir import failed");
}

const refreshService = new RefreshService(store, config, logger);
const upstream = new UpstreamClient(config, logger);

// Pool hardening — state machine + affinity + breaker (M5)
const stateMachine = new StateMachine({
  cooldownMs: config.poolCooldownMs,
  breakerThreshold: config.breakerThreshold,
});
const affinity = new CacheAffinity({
  ttlMs: config.cacheAffinityTtlMs,
  maxSize: 1000,
});
const breaker = new CircuitBreaker({
  threshold: config.breakerThreshold,
  resetMs: config.breakerResetMs,
});

const pool = new RoundRobinPool(store, refreshService, logger, {
  stateMachine,
  affinity,
  breaker,
});

logger.info({ poolSize: pool.size() }, "credential pool ready");
setCredentialsTotal(pool.size());
try {
  const stats = pool.getStats();
  setPoolStates(stats as Record<string, number>);
} catch {
  // pool stats may not be available in tests
}

// Check-in scheduler — opt-in, disabled by default (global kill-switch + per-credential flag)
let checkinScheduler: CheckinScheduler | null = null;
if (config.checkinEnabled) {
  checkinScheduler = new CheckinScheduler(store, config, logger);
  logger.info({ jitterMs: config.checkinJitterMs }, "check-in scheduler enabled");
} else {
  logger.info("check-in scheduler disabled (CODEBUFFY_CHECKIN_ENABLED=false)");
}

if (!isLoopback(config.host)) {
  logger.warn({ host: config.host }, "CODEBUFFY_HOST is not loopback — /admin/* will be reachable off-host");
}

const app = createApp({
  config,
  logger,
  startedAt: Date.now(),
  pool,
  upstream,
  refresh: refreshService,
  store,
  checkinScheduler,
});

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
});

logger.info({ host: config.host, port: config.port }, "gateway listening");

if (checkinScheduler) {
  checkinScheduler.start();
  logger.info("check-in scheduler started");
}

registerShutdown(server, logger);

// Ensure scheduler and store are closed on graceful exit
const originalShutdown = () => {
  try {
    checkinScheduler?.stop();
  } catch {
    // ignore
  }
  try {
    store.close();
  } catch {
    // ignore
  }
};
process.on("SIGINT", originalShutdown);
process.on("SIGTERM", originalShutdown);
process.on("beforeExit", originalShutdown);
