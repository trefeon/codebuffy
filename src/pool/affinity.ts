import { createHash } from "node:crypto";
import type { IRRequest } from "../ir/types";

/**
 * Cache-affinity: sticky mapping from conversation identifier → credential uid.
 *
 * Implementation is LRU via Map insertion order (oldest is first key).
 * Each entry has a TTL (default 5 minutes). Expired entries are evicted lazily
 * on get() and not returned.
 *
 * Capacity is capped at 1000 entries; insertion beyond cap evicts the oldest.
 */
export class CacheAffinity {
  private readonly map = new Map<string, { uid: string; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(options: { ttlMs?: number; maxSize?: number } = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxSize = options.maxSize ?? 1000;
  }

  set(conversationId: string, uid: string): void {
    const key = conversationId;
    // Refresh LRU position if exists
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (first inserted)
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { uid, expiresAt: Date.now() + this.ttlMs });
  }

  get(conversationId: string): string | null {
    const entry = this.map.get(conversationId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(conversationId);
      return null;
    }
    // Promote to MRU on read (LRU semantics)
    this.map.delete(conversationId);
    this.map.set(conversationId, entry);
    return entry.uid;
  }

  delete(conversationId: string): boolean {
    return this.map.delete(conversationId);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  /** For diagnostics: snapshot of keys (without exposing expiry internals). */
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

/**
 * Deterministic hash helper for affinity keys.
 *
 * Accepts a string (e.g. conversationId, IR hash, or upstream triplet) and
 * returns a stable hex string. Uses SHA-256 and truncates to 16 hex chars
 * (64 bits) — sufficient for affinity sharding without leaking raw ids.
 */
export function hashString(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

/**
 * Hash an IR request into a stable affinity key.
 *
 * Uses model + JSON of messages (role+content). The hash is intentionally
 * lightweight — callers that need stronger conversational continuity should
 * pass an explicit conversationId (e.g. upstream conversation triplet) instead.
 */
export function hashIRRequest(ir: IRRequest): string {
  const payload = JSON.stringify({
    model: ir.model,
    messages: ir.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return hashString(payload);
}

/**
 * Derive an affinity key from available signals.
 *
 * Priority:
 * 1) explicit conversationId if provided
 * 2) hash of IR request if provided
 * 3) upstream triplet (conversationId + turnId ... ) when modeled as `${a}:${b}:${c}`
 * Returns null when no signal present.
 */
export function deriveAffinityKey(input: {
  conversationId?: string;
  ir?: IRRequest;
  triplet?: { conversationId?: string; turnId?: string; messageId?: string };
}): string | null {
  if (input.conversationId) return hashString(input.conversationId);
  if (input.ir) return hashIRRequest(input.ir);
  if (input.triplet?.conversationId) {
    const raw = [
      input.triplet.conversationId ?? "",
      input.triplet.turnId ?? "",
      input.triplet.messageId ?? "",
    ].join(":");
    return hashString(raw);
  }
  return null;
}
