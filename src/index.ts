import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { registerShutdown } from "./shutdown";

const config = loadConfig();
const logger = createLogger(config);
const app = createApp({ config, logger, startedAt: Date.now() });

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
});

logger.info({ host: config.host, port: config.port }, "gateway listening");
registerShutdown(server, logger);
