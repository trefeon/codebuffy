import type { Logger } from "./logger";

interface StoppableServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

/**
 * Graceful shutdown chain (EchoPing precedent, research/05 §6): first signal
 * stops the server, second signal or timeout forces exit. Idempotent.
 */
export function registerShutdown(
  server: StoppableServer,
  logger: Logger,
  timeoutMs = 10_000,
): void {
  let shuttingDown = false;
  const handle = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, timeoutMs);
    Promise.resolve(server.stop(true)).finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}
