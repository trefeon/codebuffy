import { randomBytes } from "node:crypto";

export interface UsageEntry {
  id: string;
  time: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHit: number;
  cacheMiss: number;
  credits: number;
}

const MAX = 200;
const ring: UsageEntry[] = [];

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return 0;
}

export function parseUsage(usage: unknown): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHit: number;
  cacheMiss: number;
  credits: number;
} {
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHit: 0, cacheMiss: 0, credits: 0 };
  }
  const o = usage as Record<string, unknown>;

  let prompt = 0;
  if ("prompt_tokens" in o) prompt = toNumber(o.prompt_tokens);
  else if ("promptTokens" in o) prompt = toNumber((o as Record<string, unknown>).promptTokens);
  else if ("input_tokens" in o) prompt = toNumber(o.input_tokens);
  else if ("inputTokens" in o) prompt = toNumber((o as Record<string, unknown>).inputTokens);

  let completion = 0;
  if ("completion_tokens" in o) completion = toNumber(o.completion_tokens);
  else if ("completionTokens" in o) completion = toNumber((o as Record<string, unknown>).completionTokens);
  else if ("output_tokens" in o) completion = toNumber(o.output_tokens);
  else if ("outputTokens" in o) completion = toNumber((o as Record<string, unknown>).outputTokens);

  let total = 0;
  if ("total_tokens" in o) total = toNumber(o.total_tokens);
  else if ("totalTokens" in o) total = toNumber((o as Record<string, unknown>).totalTokens);
  else total = prompt + completion;

  let hit = 0;
  if ("prompt_cache_hit_tokens" in o) hit = toNumber(o.prompt_cache_hit_tokens);
  else if ("promptCacheHitTokens" in o) hit = toNumber((o as Record<string, unknown>).promptCacheHitTokens);
  else if ("cacheHit" in o) hit = toNumber(o.cacheHit);
  else if ("cached_tokens" in o) hit = toNumber(o.cached_tokens);
  else if ("cache_hit_tokens" in o) hit = toNumber((o as Record<string, unknown>).cache_hit_tokens);
  else if ("prompt_tokens_details" in o && o.prompt_tokens_details && typeof o.prompt_tokens_details === "object") {
    const d = o.prompt_tokens_details as Record<string, unknown>;
    if ("cached_tokens" in d) hit = toNumber(d.cached_tokens);
    else if ("cache_hit_tokens" in d) hit = toNumber((d as Record<string, unknown>).cache_hit_tokens);
    else if ("prompt_cache_hit_tokens" in d) hit = toNumber((d as Record<string, unknown>).prompt_cache_hit_tokens);
  } else if ("promptTokensDetails" in o && o.promptTokensDetails && typeof o.promptTokensDetails === "object") {
    const d = o.promptTokensDetails as Record<string, unknown>;
    if ("cached_tokens" in d) hit = toNumber(d.cached_tokens);
  }

  let miss = 0;
  if ("prompt_cache_miss_tokens" in o) miss = toNumber(o.prompt_cache_miss_tokens);
  else if ("promptCacheMissTokens" in o) miss = toNumber((o as Record<string, unknown>).promptCacheMissTokens);
  else if ("cacheMiss" in o) miss = toNumber(o.cacheMiss);
  else if ("cache_miss_tokens" in o) miss = toNumber((o as Record<string, unknown>).cache_miss_tokens);
  else if ("prompt_cache_miss" in o) miss = toNumber((o as Record<string, unknown>).prompt_cache_miss);

  // derive miss if not explicit but hit present
  if (miss === 0 && prompt > 0 && hit > 0 && hit <= prompt) {
    // keep miss as 0 or derive — leave 0 to avoid guessing, frontend can calc
  }

  let credits = 0;
  if ("credits" in o) credits = toNumber(o.credits);
  else if ("credit" in o) credits = toNumber((o as Record<string, unknown>).credit);
  else if ("total_credits" in o) credits = toNumber((o as Record<string, unknown>).total_credits);

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
    cacheHit: hit,
    cacheMiss: miss,
    credits,
  };
}

function generateCrbId(): string {
  return `crb-${randomBytes(8).toString("hex")}`;
}

export function buildUsageEntry(opts: {
  id?: string;
  model?: string;
  usage?: unknown;
  time?: string | number | Date;
}): UsageEntry {
  const id = opts.id && typeof opts.id === "string" && opts.id.length > 0 ? opts.id : generateCrbId();
  // Normalize to crb- prefix if upstream gave non-crb id but we want crb-? Keep original if it already looks like an ID, but ensure crb- for generated.
  // If id does not start with crb- and is a chatcmpl-/msg_/resp_ style, keep it — upstream real crb- will be crb- anyway.
  // Only generate fallback if empty.
  const parsed = parseUsage(opts.usage);
  const t = opts.time ? new Date(opts.time) : new Date();
  const timeIso = Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
  return {
    id,
    time: timeIso,
    model: typeof opts.model === "string" && opts.model.length > 0 ? opts.model : "auto",
    promptTokens: parsed.promptTokens,
    completionTokens: parsed.completionTokens,
    totalTokens: parsed.totalTokens,
    cacheHit: parsed.cacheHit,
    cacheMiss: parsed.cacheMiss,
    credits: parsed.credits,
  };
}

export function pushUsage(entry: UsageEntry): void {
  ring.push(entry);
  if (ring.length > MAX) ring.shift();
}

export function pushFromUpstreamChunk(opts: {
  id?: string;
  model?: string;
  usage?: unknown;
  time?: string | number | Date;
}): UsageEntry {
  const entry = buildUsageEntry(opts);
  pushUsage(entry);
  return entry;
}

export function listUsage(range?: string): UsageEntry[] {
  const all = [...ring].reverse(); // newest first
  if (!range || range === "all") return all;
  const now = Date.now();
  const r = range.trim().toLowerCase();
  let cutoff: number | null = null;
  let dayFilter: { start: number; end: number } | null = null;

  if (r === "1h") cutoff = now - 60 * 60 * 1000;
  else if (r === "6h") cutoff = now - 6 * 60 * 60 * 1000;
  else if (r === "24h" || r === "1d") cutoff = now - 24 * 60 * 60 * 1000;
  else if (r === "7d" || r === "7days" || r === "week") cutoff = now - 7 * 24 * 60 * 60 * 1000;
  else if (r === "30d" || r === "30days" || r === "month") cutoff = now - 30 * 24 * 60 * 60 * 1000;
  else if (r === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (r === "yesterday") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    start.setDate(start.getDate() - 1);
    dayFilter = { start: start.getTime(), end: end.getTime() };
  }

  if (dayFilter) {
    return all.filter((e) => {
      const t = new Date(e.time).getTime();
      return t >= dayFilter!.start && t < dayFilter!.end;
    });
  }
  if (cutoff !== null) {
    return all.filter((e) => new Date(e.time).getTime() >= cutoff!);
  }
  return all;
}

export function resetUsage(): void {
  ring.length = 0;
}

export function usageCount(): number {
  return ring.length;
}
