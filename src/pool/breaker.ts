export type BreakerState = "closed" | "open" | "half-open";

interface Entry {
  state: BreakerState;
  failures: number;
  openedAt: number | null;
  // Half-open probe tracking: true when a trial is in-flight
  probeInFlight: boolean;
}

export interface CircuitBreakerOptions {
  threshold?: number;
  resetMs?: number;
}

/**
 * Per-credential circuit breaker.
 *
 * - closed: normal operation, failures counted
 * - open: threshold exceeded, all calls denied until resetMs elapses
 * - half-open: after resetMs, single probe allowed; success -> closed,
 *   failure -> open again
 *
 * Failures are per uid. The map lazily initializes entries on first use.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly resetMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.resetMs = options.resetMs ?? 60_000;
  }

  private getOrCreate(uid: string): Entry {
    let e = this.entries.get(uid);
    if (!e) {
      e = { state: "closed", failures: 0, openedAt: null, probeInFlight: false };
      this.entries.set(uid, e);
    }
    return e;
  }

  private tryTransitionOpenToHalfOpen(uid: string, entry: Entry): void {
    if (entry.state !== "open") return;
    if (entry.openedAt === null) return;
    if (Date.now() - entry.openedAt >= this.resetMs) {
      entry.state = "half-open";
      entry.probeInFlight = false;
    }
  }

  shouldAllow(uid: string): boolean {
    const entry = this.entries.get(uid);
    if (!entry) return true;
    this.tryTransitionOpenToHalfOpen(uid, entry);
    if (entry.state === "closed") return true;
    if (entry.state === "open") return false;
    // half-open: allow exactly one probe
    if (entry.state === "half-open") {
      if (entry.probeInFlight) return false;
      // Mark probe as in-flight; caller must call recordSuccess/recordFailure to release
      entry.probeInFlight = true;
      return true;
    }
    return true;
  }

  recordFailure(uid: string): void {
    const entry = this.getOrCreate(uid);
    // If we are in half-open, failure goes straight back to open
    if (entry.state === "half-open") {
      entry.state = "open";
      entry.openedAt = Date.now();
      entry.failures = this.threshold;
      entry.probeInFlight = false;
      return;
    }

    if (entry.state === "open") {
      // Already open, refresh openedAt if threshold still exceeded
      entry.openedAt = Date.now();
      entry.failures = this.threshold;
      return;
    }

    // closed
    entry.failures += 1;
    // Check for expiry transition before counting? already closed
    if (entry.failures >= this.threshold) {
      entry.state = "open";
      entry.openedAt = Date.now();
      entry.probeInFlight = false;
    }
  }

  recordSuccess(uid: string): void {
    const entry = this.getOrCreate(uid);
    entry.state = "closed";
    entry.failures = 0;
    entry.openedAt = null;
    entry.probeInFlight = false;
  }

  getState(uid: string): BreakerState {
    const entry = this.entries.get(uid);
    if (!entry) return "closed";
    this.tryTransitionOpenToHalfOpen(uid, entry);
    return entry.state;
  }

  /** For diagnostics / testing */
  getFailures(uid: string): number {
    return this.entries.get(uid)?.failures ?? 0;
  }

  /** Snapshot for pool stats */
  snapshot(): Record<string, BreakerState> {
    const out: Record<string, BreakerState> = {};
    for (const [uid, entry] of this.entries.entries()) {
      this.tryTransitionOpenToHalfOpen(uid, entry);
      out[uid] = entry.state;
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

/**
 * Single-credential breaker (convenience for unit tests that want a
 * standalone instance without uid multiplexing).
 *
 * Exposes the same state machine but without the uid key.
 */
export class SingleCircuitBreaker {
  private inner: CircuitBreaker;
  private readonly uid: string;

  constructor(uid = "__single__", options: CircuitBreakerOptions = {}) {
    this.uid = uid;
    this.inner = new CircuitBreaker(options);
  }

  shouldAllow(): boolean {
    return this.inner.shouldAllow(this.uid);
  }
  recordFailure(): void {
    this.inner.recordFailure(this.uid);
  }
  recordSuccess(): void {
    this.inner.recordSuccess(this.uid);
  }
  getState(): BreakerState {
    return this.inner.getState(this.uid);
  }
}
