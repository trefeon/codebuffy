/**
 * CodeBuddy billing packages — POST {apiBase}/v2/billing/meter/get-user-resource
 * (same shape on CN and Intl). Response: data.Response.Data.Accounts[] mixing
 * two credit types that must NOT be merged (classification ported from
 * reference/decolua__9router/open-sse/services/usage/codebuddy-cn.js):
 *
 *  - Refill/base ("基础体验包"): recurring allowance; live numbers in the
 *    Cycle* fields, resetAt = next refresh (CycleEndTime).
 *  - Bonus ("活动赠送包"): one-shot credits; numbers in plain Capacity fields,
 *    expire for good (CycleEndTime == DeductionEndTime).
 */
import type { Credential } from "../credentials/types";
import { buildUpstreamHeaders } from "./headers";

export interface QuotaRow {
  name: string;
  used: number;
  total: number;
  resetAt: string | null;
  recurring: boolean;
}

export interface UsageQuota {
  plan: string;
  quotas: QuotaRow[];
}

interface BillingAccount {
  PackageName?: string;
  SubProductName?: string;
  CycleStartTime?: string;
  CycleEndTime?: string;
  DeductionEndTime?: number | string;
  CycleCapacityUsed?: number | string;
  CycleCapacitySize?: number | string;
  CycleCapacityUsedPrecise?: string;
  CycleCapacitySizePrecise?: string;
  CapacityUsed?: number | string;
  CapacitySize?: number | string;
  CapacityUsedPrecise?: string;
  CapacitySizePrecise?: string;
}

function num(precise: string | undefined, plain: number | string | undefined): number {
  const n = Number(precise ?? plain);
  return Number.isFinite(n) ? n : 0;
}

/** Tencent timestamps are ms since epoch as string/number. */
export function parseResetTime(v: string | undefined): string | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000;

export function isRefillPack(acc: BillingAccount): boolean {
  const ce = parseResetTime(acc.CycleEndTime);
  const de = Number(acc.DeductionEndTime);
  if (!ce || !Number.isFinite(de)) return false;
  return de - new Date(ce).getTime() > REFILL_GAP_MS;
}

function cadenceLabel(acc: BillingAccount): "Monthly" | "Weekly" | "Daily" {
  const s = parseResetTime(acc.CycleStartTime);
  const e = parseResetTime(acc.CycleEndTime);
  if (s && e) {
    const days = (new Date(e).getTime() - new Date(s).getTime()) / 86_400_000;
    if (days <= 2) return "Daily";
    if (days <= 10) return "Weekly";
  }
  return "Monthly";
}

/** Pure classifier — no I/O. */
export function classifyAccounts(accounts: BillingAccount[]): UsageQuota {
  const cycleEndMs = (a: BillingAccount) => {
    const r = parseResetTime(a.CycleEndTime);
    return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY;
  };
  const byExpiry = (x: BillingAccount, y: BillingAccount) => cycleEndMs(x) - cycleEndMs(y);

  const refills = accounts.filter(isRefillPack).sort(byExpiry);
  const bonuses = accounts.filter((a) => !isRefillPack(a)).sort(byExpiry);

  const quotas: QuotaRow[] = [];
  const seen: Record<string, number> = {};
  for (const acc of refills) {
    const base = cadenceLabel(acc);
    seen[base] = (seen[base] ?? 0) + 1;
    quotas.push({
      name: seen[base] > 1 ? `${base} ${seen[base]}` : base,
      used: num(acc.CycleCapacityUsedPrecise, acc.CycleCapacityUsed),
      total: num(acc.CycleCapacitySizePrecise, acc.CycleCapacitySize),
      resetAt: parseResetTime(acc.CycleEndTime),
      recurring: true,
    });
  }
  bonuses.forEach((acc, i) => {
    quotas.push({
      name: `Bonus Pack ${i + 1}`,
      used: num(acc.CapacityUsedPrecise, acc.CapacityUsed),
      total: num(acc.CapacitySizePrecise, acc.CapacitySize),
      resetAt: parseResetTime(acc.CycleEndTime),
      recurring: false,
    });
  });

  const basePkg = refills[0] ?? accounts[0] ?? {};
  return { plan: basePkg.PackageName ?? basePkg.SubProductName ?? "CodeBuddy", quotas };
}

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fetch + classify the billing packages for one credential. */
export async function fetchUsageQuota(
  credential: Credential,
  opts: { apiBase: string; logger: { warn: (o: unknown, m: string) => void }; fetchImpl?: typeof fetch },
): Promise<UsageQuota> {
  const f = opts.fetchImpl ?? fetch;
  const base = (credential.apiBase || opts.apiBase).replace(/\/+$/, "");
  const headers = buildUpstreamHeaders(credential);
  headers["Content-Type"] = "application/json";
  headers["Accept"] = "application/json";
  const res = await f(`${base}/v2/billing/meter/get-user-resource`, {
    method: "POST",
    headers,
    body: "{}",
  });
  if (res.status === 401 || res.status === 403) {
    throw new QuotaError("credential invalid or expired", res.status);
  }
  if (!res.ok) {
    throw new QuotaError(`quota API error (${res.status})`, res.status);
  }
  const json = (await res.json()) as { code?: number; msg?: string; data?: { Response?: { Data?: { Accounts?: BillingAccount[] } } } };
  if (json?.code !== 0) {
    throw new QuotaError(json?.msg ?? "unknown quota error", 502);
  }
  const accounts = json.data?.Response?.Data?.Accounts ?? [];
  if (accounts.length === 0) {
    opts.logger.warn({ uid: credential.uid }, "no credit package found");
  }
  return classifyAccounts(accounts);
}
