import { isRetryable } from "../upstream/errors";
import type { Pool } from "./types";
import type { Credential } from "../credentials/types";
/**
 * Credential lifecycle states.
 *
 * - active: available for selection
 * - cooldown: temporarily unavailable after a retryable failure; auto-recovers after cooldownMs
 * - banned: hard failure (code 11140) — sticky until recordSuccess
 * - quota: quota exhausted (code 14018) — sticky until recordSuccess
 */
export enum CredentialState {
  Active = "active",
  Cooldown = "cooldown",
  Banned = "banned",
  QuotaExhausted = "quota",
}

export interface CredentialMeta {
  state: CredentialState;
  failCount: number;
  cooldownUntil: number | null;
  lastErrorCode?: string;
}

export interface StateMachineOptions {
  cooldownMs?: number;
  breakerThreshold?: number;
}

/**
 * In-memory state machine for credential health.
 *
 * No DB persistence — the SQLite store remains the source of truth for
 * credential data; this map tracks transient health only.
 *
 * Transitions:
 * - 11140 -> Banned (sticky)
 * - 14018 -> QuotaExhausted (sticky)
 * - retryable (isRetryable) -> Cooldown with cooldownUntil = now + cooldownMs
 * - threshold: when failCount >= breakerThreshold the credential remains
 *   in cooldown/banned as appropriate; failCount is capped at threshold
 *   to avoid unbounded growth.
 *
 * Expiry is lazy: isAvailable() and getState() auto-promote an expired
 * cooldown back to Active.
 */
export class StateMachine {
  private readonly cooldownMs: number;
  private readonly breakerThreshold: number;
  private readonly meta = new Map<string, CredentialMeta>();

  constructor(options: StateMachineOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.breakerThreshold = options.breakerThreshold ?? 5;
  }

  private getOrCreate(uid: string): CredentialMeta {
    let m = this.meta.get(uid);
    if (!m) {
      m = { state: CredentialState.Active, failCount: 0, cooldownUntil: null };
      this.meta.set(uid, m);
    }
    return m;
  }

  private expireIfNeeded(uid: string, meta: CredentialMeta): void {
    if (meta.state === CredentialState.Cooldown && meta.cooldownUntil !== null) {
      if (Date.now() >= meta.cooldownUntil) {
        meta.state = CredentialState.Active;
        meta.cooldownUntil = null;
        // failCount is retained until recordSuccess resets it, but do not
        // keep it at threshold forever — keep it so threshold check remains stable.
        // We do not reset failCount here; recordSuccess does.
      }
    }
  }

  recordFailure(uid: string, code: number | string): void {
    const meta = this.getOrCreate(uid);
    // Expire first so we reason about fresh state
    this.expireIfNeeded(uid, meta);

    meta.failCount += 1;
    if (meta.failCount > this.breakerThreshold) {
      meta.failCount = this.breakerThreshold;
    }
    meta.lastErrorCode = String(code);

    const numeric = typeof code === "string" ? Number(code) : code;
    // Exact business-code checks take precedence over generic retryable
    if (numeric === 11140) {
      meta.state = CredentialState.Banned;
      meta.cooldownUntil = null;
      return;
    }
    if (numeric === 14018) {
      meta.state = CredentialState.QuotaExhausted;
      meta.cooldownUntil = null;
      return;
    }

    if (isRetryable(code)) {
      meta.state = CredentialState.Cooldown;
      meta.cooldownUntil = Date.now() + this.cooldownMs;
      return;
    }

    // Non-retryable codes: keep current state if already banned/quota,
    // otherwise apply threshold logic — if threshold reached, cooldown.
    if (
      meta.state === CredentialState.Banned ||
      meta.state === CredentialState.QuotaExhausted
    ) {
      return;
    }
    if (meta.failCount >= this.breakerThreshold) {
      meta.state = CredentialState.Cooldown;
      meta.cooldownUntil = Date.now() + this.cooldownMs;
    }
    // otherwise leave as Active but with incremented failCount
  }

  recordSuccess(uid: string): void {
    const meta = this.getOrCreate(uid);
    meta.state = CredentialState.Active;
    meta.failCount = 0;
    meta.cooldownUntil = null;
    meta.lastErrorCode = undefined;
  }

  /**
   * Whether the credential is currently selectable.
   * Banned and QuotaExhausted are never available.
   * Cooldown is unavailable until cooldownUntil passes (lazy expiry).
   */
  isAvailable(uid: string): boolean {
    const meta = this.meta.get(uid);
    if (!meta) return true;
    this.expireIfNeeded(uid, meta);
    if (meta.state === CredentialState.Banned) return false;
    if (meta.state === CredentialState.QuotaExhausted) return false;
    if (meta.state === CredentialState.Cooldown) return false;
    return true;
  }

  getState(uid: string): CredentialState {
    const meta = this.meta.get(uid);
    if (!meta) return CredentialState.Active;
    this.expireIfNeeded(uid, meta);
    return meta.state;
  }

  getMeta(uid: string): CredentialMeta | undefined {
    const meta = this.meta.get(uid);
    if (!meta) return undefined;
    this.expireIfNeeded(uid, meta);
    // Return shallow copy to avoid external mutation
    return { ...meta };
  }

  /**
   * Snapshot of all tracked metas. Expired cooldowns are promoted before snapshot.
   */
  toSnapshot(): Record<string, CredentialMeta> {
    const out: Record<string, CredentialMeta> = {};
    for (const [uid, meta] of this.meta.entries()) {
      this.expireIfNeeded(uid, meta);
      out[uid] = { ...meta };
    }
    return out;
  }

  /** Direct map view for getStats implementations; includes lazy expiry. */
  entries(): Array<[string, CredentialMeta]> {
    for (const [uid, meta] of this.meta.entries()) {
      this.expireIfNeeded(uid, meta);
    }
    return Array.from(this.meta.entries()).map(([k, v]) => [k, { ...v }]);
  }

  /** For testing: force clear */
  clear(): void {
    this.meta.clear();
  }

  /** For testing: size of tracked map */
  size(): number {
    return this.meta.size;
  }
}

export interface PickOptions {
  conversationId?: string;
  signal?: AbortSignal;
}

/**
 * Extended Pool interface that includes hardening APIs.
 * Kept here (not in types.ts) until Main wires the canonical types.ts.
 * Backward compatible: base Pool with optional hardening methods.
 */
export interface HardenedPool extends Pool {
  pick(options?: PickOptions): Promise<Credential | null>;
  getState(uid: string): CredentialState;
  getStats(): Record<CredentialState, number>;
}
