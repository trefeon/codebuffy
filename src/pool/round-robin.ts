import type { SqliteCredentialStore } from "../credentials/store";
import type { RefreshService } from "../credentials/refresh";
import type { Logger } from "../logger";
import type { Pool } from "./types";
import type { Credential } from "../credentials/types";
import { StateMachine, CredentialState } from "./state";
import { CacheAffinity } from "./affinity";
import { CircuitBreaker } from "./breaker";
import { UpstreamError, isRetryable } from "../upstream/errors";

export interface RoundRobinPoolOptions {
  stateMachine?: StateMachine;
  affinity?: CacheAffinity;
  breaker?: CircuitBreaker;
  cooldownMs?: number;
  breakerThreshold?: number;
  breakerResetMs?: number;
  affinityTtlMs?: number;
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
