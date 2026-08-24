import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { registerShutdown } from "./shutdown";
import { SqliteCredentialStore } from "./credentials/store";
import { RefreshService } from "./credentials/refresh";
import { UpstreamClient } from "./upstream/client";
import { RoundRobinPool } from "./pool/round-robin";
import { importPoolDir } from "./credentials/file-importer";

const config = loadConfig();
const logger = createLogger(config);

// Credential lifecycle — M1 modules now wired into the serving path (M2)
const store = new SqliteCredentialStore(config.dbPath);

// Best-effort import of pool files produced by scripts/onboard-account.mjs.
// Awaited before pool construction so startup log reflects actual size.
try {
  const { imported, skipped } = await importPoolDir("data/pool", store);
  if (imported > 0 || skipped > 0) {
    logger.info({ imported, skipped }, "pool dir import complete");
  }
} catch (err) {
  logger.warn({ err }, "pool dir import failed");
}

const refreshService = new RefreshService(store, config, logger);
const upstream = new UpstreamClient(config, logger);
const pool = new RoundRobinPool(store, refreshService, logger);

logger.info({ poolSize: pool.size() }, "credential pool ready");

const app = createApp({ config, logger, startedAt: Date.now(), pool, upstream });

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
});

logger.info({ host: config.host, port: config.port }, "gateway listening");
registerShutdown(server, logger);

// Ensure store is closed on graceful exit (registerShutdown will call process.exit,
// so also hook beforeExit)
process.on("beforeExit", () => {
  try {
    store.close();
  } catch {
    // ignore
  }
});
