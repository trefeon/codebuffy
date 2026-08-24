import fs from "node:fs";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("127.0.0.1"),
  logLevel: z.enum(LOG_LEVELS).default("info"),
  apiBase: z.string().default("https://copilot.tencent.com"),
  consoleBase: z.string().default("https://www.codebuddy.cn"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Layering per devdocs/decisions/0003-config-layering.md: defaults < config.json < CODEBUFFY_* env. */
const ENV_MAP: Record<keyof Config, string> = {
  port: "CODEBUFFY_PORT",
  host: "CODEBUFFY_HOST",
  logLevel: "CODEBUFFY_LOG_LEVEL",
  apiBase: "CODEBUFFY_API_BASE",
  consoleBase: "CODEBUFFY_CONSOLE_BASE",
};

export type ConfigEnv = Record<string, string | undefined>;
export type FileReader = (path: string) => string | null;

function defaultReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function assertHttpUrl(kind: "apiBase" | "consoleBase", value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`config.${kind} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`config.${kind} must be http(s): ${value}`);
  }
}

/**
 * Loads and validates configuration. Pure in its inputs so tests can inject
 * an env object and a file reader. Throws with a readable message on any
 * invalid value — fail closed at startup.
 */
export function loadConfig(
  env: ConfigEnv = process.env,
  readFile: FileReader = defaultReadFile,
): Config {
  // 1) file layer (optional config.json at repo root)
  let raw: Record<string, unknown> = {};
  const fileText = readFile("config.json");
  if (fileText !== null) {
    const parsed: unknown = JSON.parse(fileText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json must contain a JSON object");
    }
    raw = parsed as Record<string, unknown>;
  }

  // 2) env layer overrides file
  for (const [key, envName] of Object.entries(ENV_MAP)) {
    const v = env[envName];
    if (v !== undefined && v !== "") raw[key] = v;
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration -> ${issues}`);
  }
  const cfg = result.data;
  assertHttpUrl("apiBase", cfg.apiBase);
  assertHttpUrl("consoleBase", cfg.consoleBase);
  return Object.freeze(cfg);
}
