import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Credential } from "../credentials/types.js";
import type { SqliteCredentialStore } from "../credentials/store.js";
import { performCheckin, type CheckinResult, type FetchFn } from "./client.js";
import { isCheckinEnabled } from "./types.js";

export const CHECKIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JITTER_MS = 3600000;

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  jitterMs: number;
}

function getGlobalEnabled(config: Config): boolean {
  return Boolean((config as unknown as Record<string, unknown>).checkinEnabled);
}

function getJitterMs(config: Config): number {
  const raw = (config as unknown as Record<string, unknown>).checkinJitterMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_JITTER_MS;
}

export class CheckinScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private started = false;

  constructor(
    private readonly store: SqliteCredentialStore,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly fetchFn?: FetchFn,
  ) {}

  /** Jittered delay for the next iteration: interval ± jitter. */
  computeDelay(): number {
    const jitter = getJitterMs(this.config);
    if (jitter === 0) return CHECKIN_INTERVAL_MS;
    const delta = (Math.random() * 2 - 1) * jitter;
    return CHECKIN_INTERVAL_MS + delta;
  }

  getStatus(): SchedulerStatus {
    return {
      enabled: getGlobalEnabled(this.config),
      running: this.running,
      intervalMs: CHECKIN_INTERVAL_MS,
      jitterMs: getJitterMs(this.config),
    };
  }

  start(): void {
    if (!getGlobalEnabled(this.config)) {
      this.logger.info("checkin scheduler disabled (global flag false)");
      return;
    }
    if (this.started) return;
    this.started = true;
    this.running = true;
    this.logger.info(
      { intervalMs: CHECKIN_INTERVAL_MS, jitterMs: getJitterMs(this.config) },
      "checkin scheduler started",
    );
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = this.computeDelay();
    this.logger.debug({ delay }, "scheduling next checkin");
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error({ err }, "checkin runOnce failed");
      } finally {
        if (this.running) this.scheduleNext();
      }
    }, delay);
  }

  /**
   * Iterate credentials filtered by isCheckinEnabled and call performCheckin
   * sequentially with a small inter-call delay to avoid thundering herd.
   */
  async runOnce(): Promise<void> {
    if (!getGlobalEnabled(this.config)) return;
    let creds: Credential[];
    try {
      creds = this.store.list();
    } catch (err) {
      this.logger.error({ err }, "checkin: failed to list credentials");
      return;
    }
    const targets = creds.filter((c) => isCheckinEnabled(c, true));
    if (targets.length === 0) {
      this.logger.debug("checkin: no enabled credentials");
      return;
    }
    for (const cred of targets) {
      try {
        const result = await performCheckin(cred, this.config, this.logger, this.fetchFn);
        this.logger.info({ uid: cred.uid, result }, "checkin success");
      } catch (err) {
        this.logger.error({ err, uid: cred.uid }, "checkin failed");
      }
      // Small sequential delay (100ms)
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Trigger a single credential check-in (admin endpoint).
   * Respects global kill-switch; throws if disabled or credential missing.
   */
  async trigger(uid: string): Promise<CheckinResult> {
    if (!getGlobalEnabled(this.config)) {
      throw new Error("checkin disabled (global flag false)");
    }
    const cred = this.store.get(uid);
    if (!cred) {
      throw new Error(`credential not found: ${uid}`);
    }
    // Trigger is an explicit admin action — proceed regardless of per-credential flag,
    // but log a warning if the flag was off.
    const perCredEnabled = isCheckinEnabled(cred, true);
    if (!perCredEnabled) {
      this.logger.warn({ uid }, "triggering checkin for credential with checkinEnabled=false");
    }
    return performCheckin(cred, this.config, this.logger, this.fetchFn);
  }
}
