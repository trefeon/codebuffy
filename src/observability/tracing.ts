import type { Logger } from "../logger";
import type { Config } from "../config";

type MaybeLogger = Pick<Logger, "info" | "warn" | "debug" | "error">;

type NodeSDKInstance = {
  start: () => void | Promise<void>;
};

type NodeSDKCtor = new (cfg: unknown) => NodeSDKInstance;

type SdkModule = {
  NodeSDK?: NodeSDKCtor;
};

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

function isSdkModule(mod: unknown): mod is SdkModule {
  return typeof mod === "object" && mod !== null && "NodeSDK" in mod;
}

/**
 * Opt-in OpenTelemetry tracing.
 *
 * - No hard dependency on `@opentelemetry/sdk-node` — the package is optional.
 * - No-op when `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` is unset (default).
 * - When the env var is set, lazily imports `sdk-node` and starts a NodeSDK.
 *   If the package is not installed the error is swallowed and a warning is
 *   logged (when a logger is supplied); the gateway continues without tracing.
 *
 * Call `initTracing(config, logger)` once at startup before `Bun.serve`.
 */
export function initTracing(config?: unknown, logger?: unknown): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return;
  }

  const maybeLogger = logger as MaybeLogger | undefined;
  const cfg = config as Config | undefined;

  // Fire-and-forget: do not block startup on OTel init.
  // @ts-expect-error — optional dep, may not be installed; lazy import follows
  void (import("@opentelemetry/sdk-node") as Promise<unknown>).then((mod: unknown) => {
      const sdkMod: SdkModule | null = isSdkModule(mod) ? mod : null;
      const NodeSDKCtor = sdkMod?.NodeSDK;
      if (!NodeSDKCtor) {
        maybeLogger?.warn("OTel: @opentelemetry/sdk-node does not export NodeSDK — tracing disabled");
        return;
      }

      const rawHost = (cfg as Config)?.host;
      const hostLabel = rawHost && !["0.0.0.0", "::", "0:0:0:0:0:0:0:1"].includes(rawHost) ? rawHost : "";
      const serviceName = hostLabel ? `codebuffy-${hostLabel}` : "codebuffy";
      const sdk = new NodeSDKCtor({
        serviceName,
      });

      const started = sdk.start();
      if (isPromiseLike(started)) {
        void started
          .then(() => {
            maybeLogger?.info({ endpoint, serviceName }, "OTel tracing started");
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            const maybeErr = err as NodeJS.ErrnoException;
            const code = maybeErr?.code || "UNKNOWN";
            maybeLogger?.warn({ code, err: message }, "OTel SDK start failed — continuing without tracing");
          });
      } else {
        maybeLogger?.info({ endpoint, serviceName }, "OTel tracing started");
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const maybeErr = err as NodeJS.ErrnoException;
      const code = maybeErr?.code || "UNKNOWN";
      // Missing optional dep yields MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND
      maybeLogger?.warn(
        { code, err: message },
        "OTel tracing requested but @opentelemetry/sdk-node not installed — continuing without tracing",
      );
    });
}
