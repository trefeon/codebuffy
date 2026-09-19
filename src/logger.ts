import pino from "pino";
import type { Config } from "./config";

export type Logger = pino.Logger;

export function createLogger(config: Config): Logger {
  return pino({
    level: config.logLevel,
    base: { service: "codebuffy" },
    // Secrets never reach the sink even on accidental inclusion (doc 02 §9.4 lesson).
    redact: {
      paths: [
        "accessToken",
        "refreshToken",
        "apiKey",
        "*.accessToken",
        "*.refreshToken",
        "*.apiKey",
        "authorization",
        "headers.authorization",
        "Authorization",
        "headers.Authorization",
        "X-API-Key",
        "headers.X-API-Key",
        "x-api-key",
        "headers.x-api-key",
        "X-Refresh-Token",
        "headers.X-Refresh-Token",
        "x-refresh-token",
        "headers.x-refresh-token",
      ],
      censor: "[REDACTED]",
    },
  });
}
