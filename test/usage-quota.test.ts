import { describe, expect, test } from "bun:test";
import { classifyAccounts, isRefillPack } from "../src/upstream/usage-quota";

const NOW = 1787741091000; // fixed epoch for deterministic expiry math

function acc(over: Record<string, unknown> = {}) {
  return {
    PackageName: "Free",
    CycleStartTime: String(NOW - 20 * 86_400_000),
    CycleEndTime: String(NOW + 10 * 86_400_000),
    DeductionEndTime: NOW + 40 * 86_400_000,
    CycleCapacityUsedPrecise: "6.54",
    CycleCapacitySizePrecise: "500",
    CapacityUsedPrecise: "10",
    CapacitySizePrecise: "3300",
    ...over,
  };
}

describe("isRefillPack", () => {
  test("refill when deduction end far exceeds cycle end (>2d gap)", () => {
    expect(isRefillPack(acc())).toBe(true);
  });
  test("bonus when cycle end == deduction end (one-shot)", () => {
    const end = NOW + 30 * 86_400_000;
    expect(isRefillPack(acc({ CycleEndTime: String(end), DeductionEndTime: end }))).toBe(false);
  });
});

describe("classifyAccounts", () => {
  test("labels refill by cadence and bonuses soonest-expiring-first", () => {
    const bonusOlder = acc({
      CycleStartTime: undefined,
      CycleEndTime: String(NOW + 5 * 86_400_000),
      DeductionEndTime: NOW + 5 * 86_400_000,
      CapacityUsedPrecise: "1",
      CapacitySizePrecise: "100",
      SubProductName: "活动赠送包A",
    });
    const bonusNewer = acc({
      CycleEndTime: String(NOW + 9 * 86_400_000),
      DeductionEndTime: NOW + 9 * 86_400_000,
      CapacityUsedPrecise: "2",
      CapacitySizePrecise: "200",
      SubProductName: "活动赠送包B",
    });
    const { plan, quotas } = classifyAccounts([bonusNewer, acc(), bonusOlder]);
    expect(plan).toBe("Free");
    expect(quotas.map((q) => q.name)).toEqual(["Monthly", "Bonus Pack 1", "Bonus Pack 2"]);
    const refill = quotas[0]!;
    expect(refill.recurring).toBe(true);
    expect(refill.used).toBeCloseTo(6.54);
    expect(refill.total).toBe(500);
    const b1 = quotas[1]!;
    expect(b1.recurring).toBe(false);
    expect(b1.used).toBe(1);
    expect(b1.total).toBe(100);
  });

  test("empty accounts yield plan-only result", () => {
    const { plan, quotas } = classifyAccounts([]);
    expect(plan).toBe("CodeBuddy");
    expect(quotas).toHaveLength(0);
  });
});
