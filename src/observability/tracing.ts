import type { Logger } from "../logger";
import type { Config } from "../config";
import type { MiddlewareHandler } from "hono";

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

// ---- G4 per-request spans (additive; no new hard dependencies) ----

export interface SpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  end(status?: { code?: number; message?: string }): void;
}

const noopSpan: SpanHandle = {
  setAttribute: () => {},
  recordException: () => {},
  end: () => {},
};

type OTelSpanLike = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: string | Error): void;
  end(): void;
};

type TracerLike = {
  startSpan(name: string, options?: unknown): OTelSpanLike;
};

// Set once the optional @opentelemetry/api import resolves; null = unavailable.
let cachedTracer: TracerLike | null | undefined;
let apiLoad: Promise<unknown> | null = null;

function ensureTraceApi(): void {
  if (apiLoad) return;
  // @ts-expect-error — optional dep, may not be installed; lazy import follows
  apiLoad = (import("@opentelemetry/api") as Promise<unknown>)
    .then((mod: unknown) => {
      try {
        const trace = (mod as { trace?: { getTracer?: (name: string) => TracerLike } }).trace;
        cachedTracer = trace?.getTracer?.("codebuffy") ?? null;
      } catch {
        cachedTracer = null;
      }
    })
    .catch(() => {
      cachedTracer = null;
    });
}

/**
 * Start a per-request span. Synchronous and cheap when tracing is unavailable:
 * returns a shared no-op handle until the optional @opentelemetry/api import
 * resolves. Never throws.
 */
export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
): SpanHandle {
  ensureTraceApi();
  const tracer = cachedTracer;
  if (!tracer) return noopSpan;
  try {
    const span = tracer.startSpan(name, attributes ? { attributes } : undefined);
    return {
      setAttribute: (key, value) => {
        try {
          span.setAttribute(key, value);
        } catch {
          // ignore backend errors on the hot path
        }
      },
      recordException: (err) => {
        try {
          span.recordException(err instanceof Error ? err : String(err));
        } catch {
          // ignore backend errors on the hot path
        }
      },
      end: (status) => {
        try {
          // SpanStatusCode.ERROR = 2; no status = UNSET/OK default.
          if (status && (status.code !== undefined || status.message !== undefined)) {
            span.setStatus({ code: status.code ?? 2, message: status.message });
          }
          span.end();
        } catch {
          // ignore backend errors on the hot path
        }
      },
    };
  } catch {
    return noopSpan;
  }
}

/**
 * Standalone Hono middleware wiring per-request spans into routes. Hookup
 * (one line next to metricsMiddleware in createApp):
 *   app.use("*", tracingMiddleware());
 * The metricsMiddleware path already starts the same spans, so mount one or
 * the other on an app — never both.
 */
export function tracingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const span = startSpan(`${c.req.method} ${c.req.path}`, {
      "http.method": c.req.method,
      "http.target": c.req.path,
    });
    try {
      await next();
      span.setAttribute("http.status_code", c.res.status);
      span.end();
    } catch (err) {
      span.recordException(err);
      span.end({ code: 2, message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
}