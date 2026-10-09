import { describe, it, expect } from "vitest";
import { allocateDebit, computeMeter } from "@/lib/credits-math";
import { DEFAULT_PLANS as PLANS, expectedPrice } from "@/lib/plans";

describe("allocateDebit", () => {
  it("takes monthly first", () => {
    expect(allocateDebit({ monthly: 10, purchased: 100 }, 4)).toEqual({ fromMonthly: 4, fromPurchased: 0, shortfall: 0 });
  });
  it("spills into purchased", () => {
    expect(allocateDebit({ monthly: 3, purchased: 100 }, 10)).toEqual({ fromMonthly: 3, fromPurchased: 7, shortfall: 0 });
  });
  it("reports shortfall", () => {
    expect(allocateDebit({ monthly: 2, purchased: 3 }, 10)).toEqual({ fromMonthly: 2, fromPurchased: 3, shortfall: 5 });
  });
  it("ignores negative balances", () => {
    expect(allocateDebit({ monthly: -5, purchased: 4 }, 2)).toEqual({ fromMonthly: 0, fromPurchased: 2, shortfall: 0 });
  });
});

describe("computeMeter", () => {
  const startedAt = new Date("2025-01-01T00:00:00Z");
  const at = (s: number) => new Date(startedAt.getTime() + s * 1000);
  it("bills elapsed server seconds", () => {
    const r = computeMeter({ liveAt: startedAt, now: at(10), secondsBilled: 0, maxSeconds: 120, balance: 300 });
    expect(r).toMatchObject({ debit: 10, remaining: 290, continue: true });
  });
  it("is idempotent for repeated ticks at the same instant", () => {
    const r = computeMeter({ liveAt: startedAt, now: at(10), secondsBilled: 10, maxSeconds: 120, balance: 290 });
    expect(r.debit).toBe(0);
  });
  it("stops at zero credits and never overdraws", () => {
    const r = computeMeter({ liveAt: startedAt, now: at(50), secondsBilled: 40, maxSeconds: 120, balance: 4 });
    expect(r).toMatchObject({ debit: 4, remaining: 0, continue: false, reason: "credits" });
  });
  it("stops at the plan session limit", () => {
    const r = computeMeter({ liveAt: startedAt, now: at(500), secondsBilled: 100, maxSeconds: 120, balance: 1000 });
    expect(r).toMatchObject({ debit: 20, continue: false, reason: "session_limit" });
  });
  it("ignores clock skew into the past", () => {
    const r = computeMeter({ liveAt: startedAt, now: at(-5), secondsBilled: 0, maxSeconds: 120, balance: 10 });
    expect(r.debit).toBe(0);
  });
  it("bills only whole live seconds, and a fraction left by one tick is billed by the next, never twice", () => {
    const ms = (x: number) => new Date(startedAt.getTime() + x);
    const a = computeMeter({ liveAt: startedAt, now: ms(9_900), secondsBilled: 0, maxSeconds: 120, balance: 300 });
    expect(a.debit).toBe(9);
    const b = computeMeter({ liveAt: startedAt, now: ms(20_100), secondsBilled: a.secondsBilled, maxSeconds: 120, balance: a.remaining });
    expect(b.debit).toBe(11); // 9.9 → 20.1 s: the 0.9 s left over plus 10.2 s, in whole seconds
    const total = b.secondsBilled;
    expect(total).toBe(20);
    expect(computeMeter({ liveAt: startedAt, now: ms(20_999), secondsBilled: total, maxSeconds: 120, balance: b.remaining }).debit).toBe(0);
  });
  it("measures the plan limit from the first frame, not from the session start", () => {
    const liveAt = at(25); // 25 s were spent connecting
    const r = computeMeter({ liveAt, now: at(25 + 120), secondsBilled: 100, maxSeconds: 120, balance: 1000 });
    expect(r).toMatchObject({ debit: 20, secondsBilled: 120, continue: false, reason: "session_limit" });
    expect(computeMeter({ liveAt, now: at(25 + 119), secondsBilled: 100, maxSeconds: 120, balance: 1000 })).toMatchObject({ debit: 19, continue: true });
  });
});

describe("plan config", () => {
  it("matches spec", () => {
    expect(PLANS.FREE).toMatchObject({ monthlyCredits: 300, maxSessionSeconds: 120, maxResolution: "low", presets: 3, historyDays: 7 });
    expect(PLANS.PRO).toMatchObject({ monthlyCredits: 6000, maxSessionSeconds: 1800, presets: 100, historyDays: 365 });
    expect(PLANS.LIFETIME.historyDays).toBeNull();
  });
  it("reads prices from env and rejects missing ones", () => {
    process.env.PRICE_TOPUP_1K = "300000";
    process.env.PRICE_CURRENCY = "NGN";
    expect(expectedPrice("TOPUP_1K")).toEqual({ amountMinor: 300000, currency: "NGN" });
    delete process.env.PRICE_LIFETIME;
    expect(() => expectedPrice("LIFETIME")).toThrow();
  });
});
