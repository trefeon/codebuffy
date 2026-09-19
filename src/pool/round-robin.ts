import type { SqliteCredentialStore } from "../credentials/store";
import type { RefreshService } from "../credentials/refresh";
import type { Logger } from "../logger";
import type { Pool } from "./types";
import type { Credential } from "../credentials/types";
import { StateMachine, CredentialState } from "./state";
import { CacheAffinity } from "./affinity";
import { CircuitBreaker } from "./breaker";
import { UpstreamError, isRetryable } from "../upstream/errors";
import { incUpstreamErrorsTotal } from "../observability/metrics";

// ---- G6 admission control (additive; pick()/report* paths untouched) ----
// TODO(Lane A): promote these to src/config.ts knobs (e.g. poolMaxInflight /
// poolMaxQueue) once Lane A lands config keys; hardcoded conservative defaults here.
export const DEFAULT_MAX_INFLIGHT = 64;
export const DEFAULT_MAX_QUEUE = 128;
export const DEFAULT_ADMISSION_RETRY_AFTER_SECONDS = 1;

export interface AdmissionOptions {
  maxInflight?: number;
  maxQueue?: number;
  retryAfterSeconds?: number;
}

export interface AdmissionStats {
  inflight: number;
  queued: number;
  maxInflight: number;
  maxQueue: number;
}

/**
 * Thrown when both the in-flight cap and the bounded queue are saturated.
 * Carries its HTTP mapping (503 + Retry-After) so route layers can translate
 * it without importing HTTP types into the pool.
 */
export class AdmissionRejectedError extends Error {
  readonly status = 503;
  readonly code = "ADMISSION_SATURATED";
  readonly retryAfter: number;

  constructor(retryAfter: number = DEFAULT_ADMISSION_RETRY_AFTER_SECONDS) {
    super("server saturated: admission queue full");
    this.name = "AdmissionRejectedError";
    this.retryAfter = retryAfter;
  }

  toHeaders(): Record<string, string> {
    return { "Retry-After": String(this.retryAfter) };
  }

  toJSON(): unknown {
    return {
      error: { message: this.message, type: "server_error", code: this.code },
    };
  }
}

export interface RoundRobinPoolOptions {
  stateMachine?: StateMachine;
  affinity?: CacheAffinity;
  breaker?: CircuitBreaker;
  cooldownMs?: number;
  breakerThreshold?: number;
  breakerResetMs?: number;
  affinityTtlMs?: number;
  /** G6 admission control overrides; conservative in-module defaults apply when omitted. */
  admission?: AdmissionOptions;
}

export interface PickOptions {
  conversationId?: string;
  signal?: AbortSignal;
}

function extractCode(err: unknown): number | string {
  if (err instanceof UpstreamError) return err.code;
  if (err && typeof err === "object" && "code" in (err as Record<string, unknown>)) {
    const c = (err as Record<string, unknown>).code;
    if (typeof c === "number" || typeof c === "string") return c;
  }
  if (err && typeof err === "object" && "httpStatus" in (err as Record<string, unknown>)) {
    const s = (err as Record<string, unknown>).httpStatus;
    if (typeof s === "number") return s;
  }
  return "UNKNOWN";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

export class RoundRobinPool implements Pool {
  private idx = 0;
  private readonly stateMachine: StateMachine;
  private readonly affinity: CacheAffinity;
  private readonly breaker: CircuitBreaker;
  private readonly maxInflight: number;
  private readonly maxQueue: number;
  private readonly admissionRetryAfter: number;
  private inflight = 0;
  private readonly admissionWaiters: Array<() => void> = [];

  constructor(
    private readonly store: SqliteCredentialStore,
    private readonly refresh: RefreshService,
    private readonly logger: Logger,
    options: RoundRobinPoolOptions = {},
  ) {
    this.stateMachine =
      options.stateMachine ??
      new StateMachine({
        cooldownMs: options.cooldownMs ?? 30_000,
        breakerThreshold: options.breakerThreshold ?? 5,
      });
    this.affinity =
      options.affinity ??
      new CacheAffinity({
        ttlMs: options.affinityTtlMs ?? 300_000,
        maxSize: 1000,
      });
    this.breaker =
      options.breaker ??
      new CircuitBreaker({
        threshold: options.breakerThreshold ?? 5,
        resetMs: options.breakerResetMs ?? 60_000,
      });
    const admission = options.admission ?? {};
    const rawInflight = admission.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    const rawQueue = admission.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.maxInflight = Number.isFinite(rawInflight)
      ? Math.max(1, Math.floor(rawInflight))
      : DEFAULT_MAX_INFLIGHT;
    this.maxQueue = Number.isFinite(rawQueue)
      ? Math.max(0, Math.floor(rawQueue))
      : DEFAULT_MAX_QUEUE;
    this.admissionRetryAfter = admission.retryAfterSeconds ?? DEFAULT_ADMISSION_RETRY_AFTER_SECONDS;
  }

  // Overload maintains backward compatibility: Pool interface declares pick() with no args.
  async pick(): Promise<Credential | null>;
  async pick(options: PickOptions): Promise<Credential | null>;
  async pick(options?: PickOptions): Promise<Credential | null> {
    if (options?.signal?.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    const list = this.store.list();
    const len = list.length;
    if (len === 0) return null;

    const conversationId = options?.conversationId;
    const signal = options?.signal;
    let affinityAttemptedUid: string | null = null;

    // 1) Affinity fast-path
    if (conversationId) {
      const affinityUid = this.affinity.get(conversationId);
      if (affinityUid) {
        affinityAttemptedUid = affinityUid;
        const exists = list.some((c) => c.uid === affinityUid) || this.store.get(affinityUid) !== null;
        if (!exists) {
          this.affinity.delete(conversationId);
          affinityAttemptedUid = null;
        } else if (this.stateMachine.isAvailable(affinityUid) && this.breaker.shouldAllow(affinityUid)) {
          if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          try {
            const fresh = await this.refresh.ensureFresh(affinityUid);
            this.stateMachine.recordSuccess(affinityUid);
            this.breaker.recordSuccess(affinityUid);
            this.affinity.set(conversationId, affinityUid);
            return fresh;
          } catch (err) {
            const code = extractCode(err);
            this.stateMachine.recordFailure(affinityUid, code);
            this.breaker.recordFailure(affinityUid);
            this.logger.warn({ uid: affinityUid, err, code }, "pool affinity refresh failed");
            // fall through to round-robin scanning
          }
        }
      }
    }

    // 2) Round-robin scanning with health filtering and retry backoff
    for (let attempts = 0; attempts < len; attempts++) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      const candidate = list[this.idx % len];
      this.idx = (this.idx + 1) % Number.MAX_SAFE_INTEGER;
      if (!candidate) continue;

      const uid = candidate.uid;

      // Skip the credential we already attempted via affinity to avoid double-try
      if (affinityAttemptedUid !== null && uid === affinityAttemptedUid) continue;
      if (!this.stateMachine.isAvailable(uid)) continue;
      if (!this.breaker.shouldAllow(uid)) continue;

      try {
        const fresh = await this.refresh.ensureFresh(uid);
        this.stateMachine.recordSuccess(uid);
        this.breaker.recordSuccess(uid);
        if (conversationId) {
          this.affinity.set(conversationId, uid);
        }
        return fresh;
      } catch (err) {
        const code = extractCode(err);
        this.stateMachine.recordFailure(uid, code);
        this.breaker.recordFailure(uid);
        this.logger.warn({ uid, err, code }, "pool skip failed refresh");

        if (isRetryable(code) && attempts < 3) {
          const delay = 100 * Math.pow(2, attempts);
          try {
            await sleep(delay, signal);
          } catch (abortErr) {
            throw abortErr;
          }
        }
        continue;
      }
    }

    return null;
  }

  size(): number {
    return this.store.list().length;
  }

  getState(uid: string): CredentialState {
    return this.stateMachine.getState(uid);
  }

  /**
   * Route seam — feed inference-time outcomes into the same state machine and
   * breaker that pick() uses, so a credential failing mid-traffic (banned,
   * quota, auth) leaves rotation immediately instead of staying Active.
   */
  reportSuccess(uid: string): void {
    this.stateMachine.recordSuccess(uid);
    this.breaker.recordSuccess(uid);
  }

  reportFailure(uid: string, code: number | string): void {
    this.stateMachine.recordFailure(uid, code);
    this.breaker.recordFailure(uid);
  }

  getStats(): Record<CredentialState, number> {
    const counts: Record<CredentialState, number> = {
      [CredentialState.Active]: 0,
      [CredentialState.Cooldown]: 0,
      [CredentialState.Banned]: 0,
      [CredentialState.QuotaExhausted]: 0,
    };
    const list = this.store.list();
    for (const cred of list) {
      const state = this.stateMachine.getState(cred.uid);
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * G6 admission control — bounded fair semaphore guarding concurrent upstream
   * work. Fast path grants immediately; overflow waits FIFO up to maxQueue;
   * beyond that throws AdmissionRejectedError (503 + Retry-After) and counts
   * the rejection in upstream_errors_total as code admission_saturated.
   */
  getAdmissionStats(): AdmissionStats {
    return {
      inflight: this.inflight,
      queued: this.admissionWaiters.length,
      maxInflight: this.maxInflight,
      maxQueue: this.maxQueue,
    };
  }

  async acquireAdmission(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (this.inflight < this.maxInflight && this.admissionWaiters.length === 0) {
      this.inflight += 1;
      return;
    }
    if (this.admissionWaiters.length >= this.maxQueue) {
      incUpstreamErrorsTotal("admission_saturated");
      throw new AdmissionRejectedError(this.admissionRetryAfter);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    const grant = (): void => {
      if (settled) return;
      settled = true;
      this.inflight += 1;
      resolve();
    };
    this.admissionWaiters.push(grant);
    const onAbort = (): void => {
      if (settled) return;
      const at = this.admissionWaiters.indexOf(grant);
      if (at === -1) return;
      settled = true;
      this.admissionWaiters.splice(at, 1);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      await promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  releaseAdmission(): void {
    const next = this.admissionWaiters.shift();
    if (next) {
      // Slot transfers directly to the longest waiter; inflight unchanged.
      next();
      return;
    }
    if (this.inflight > 0) this.inflight -= 1;
  }

  async withAdmission<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquireAdmission(signal);
    try {
      return await fn();
    } finally {
      this.releaseAdmission();
    }
  }

  /** Expose internals for tests / observability */
  getStateMachine(): StateMachine {
    return this.stateMachine;
  }

  getAffinity(): CacheAffinity {
    return this.affinity;
  }

  getBreaker(): CircuitBreaker {
    return this.breaker;
  }
}
