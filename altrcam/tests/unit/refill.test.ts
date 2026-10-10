/**
 * Monthly refills. The margin guard assumes a Pro monthly payment hands out one month's allowance, Pro yearly twelve and Lifetime
 * one per month; these tests hold the refill rules (lib/credits-math.ts refillDue) and the real cron route to that.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, users } from "@/db/schema";
import { addMonthsUTC, refillDue, type RefillState } from "@/lib/credits-math";
import { ledgerBalance } from "@/lib/credits";
import { GET as refillRoute } from "@/app/api/cron/refill/route";

const D = (s: string) => new Date(`${s}T10:00:00Z`);
const DAY = 86_400_000;

describe("addMonthsUTC", () => {
  it("adds calendar months and clamps to the end of shorter months", () => {
    expect(addMonthsUTC(D("2026-01-15"), 1).toISOString()).toBe("2026-02-15T10:00:00.000Z");
    expect(addMonthsUTC(D("2026-01-31"), 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonthsUTC(D("2026-01-31"), 2).toISOString()).toBe("2026-03-31T10:00:00.000Z");
    expect(addMonthsUTC(D("2027-12-31"), 2).toISOString()).toBe("2028-02-29T10:00:00.000Z");
  });
});

/**
 * Run the daily job from `start` for `days` days. `payments` are the days a payment lands (it resets the bucket and starts a cycle,
 * like fulfilPayment); `paidThrough(d)` is users.plan_renews_at after a payment on day d. Returns every refill, with its cause.
 */
function simulate(plan: RefillState["plan"], start: Date, days: number, payments: Date[], paidThrough: (d: Date) => Date | null) {
  const s: RefillState = { plan, planRenewsAt: null, lastRefillAt: null, anchor: null };
  const grants: { at: Date; by: string }[] = [];
  for (let t = start.getTime(); t < start.getTime() + days * DAY; t += DAY) {

    for (const p of payments) if (p.getTime() <= t && p.getTime() > t - DAY) {
      s.anchor = { at: p, ref: `pay:${p.toISOString()}` }; s.lastRefillAt = p; s.planRenewsAt = paidThrough(p); grants.push({ at: p, by: "payment" });
    }
    const cron = new Date(t + 14 * 3_600_000); // the job runs once a day, after the payments of that day
    const due = refillDue(s, cron);
    if (due) { s.lastRefillAt = cron; grants.push({ at: cron, by: due.refId }); }

  }
  return grants;
}
const within = (g: { at: Date }[], from: Date, to: Date) => g.filter((x) => x.at.getTime() >= from.getTime() && x.at.getTime() < to.getTime()).length;

describe("refillDue: one allowance per month, never two", () => {
  it("Free: once per UTC calendar month; an account opened this month already has its signup grant", () => {
    expect(refillDue({ plan: "FREE", planRenewsAt: null, lastRefillAt: D("2026-03-20"), anchor: null }, D("2026-03-28"))).toBeNull();
    expect(refillDue({ plan: "FREE", planRenewsAt: null, lastRefillAt: D("2026-03-20"), anchor: null }, D("2026-04-01"))).toEqual({ refId: "2026-04" });
    expect(refillDue({ plan: "FREE", planRenewsAt: null, lastRefillAt: null, anchor: null }, D("2026-04-02"))).toEqual({ refId: "2026-04" });
  });
  it("Pro monthly: each payment grants one allowance and the job adds none, including a purchase on the 31st", () => {
    const pays = Array.from({ length: 6 }, (_, i) => addMonthsUTC(D("2026-01-31"), i));
    const g = simulate("PRO", pays[0], 185, pays, (d) => new Date(d.getTime() + 31 * DAY));
    expect(g.filter((x) => x.by !== "payment")).toEqual([]); // the old calendar refill granted a second allowance on Feb 1
    for (let i = 0; i < 5; i++) expect(within(g, pays[i], pays[i + 1])).toBe(1);
  });
  it("Pro monthly that is not renewed (cancelled or a failed card) gets nothing more", () => {
    const g = simulate("PRO", D("2026-01-15"), 120, [D("2026-01-15")], (d) => new Date(d.getTime() + 31 * DAY));
    expect(g).toHaveLength(1);
  });
  it("Pro yearly: the payment plus 11 anniversary refills = 12 allowances for the year, the renewal starts the next 12", () => {
    const buy = D("2026-03-31"), renew = addMonthsUTC(buy, 12);
    const g = simulate("PRO", buy, 800, [buy, renew], (d) => new Date(d.getTime() + 366 * DAY));
    expect(within(g, buy, renew)).toBe(12);
    expect(within(g, renew, addMonthsUTC(renew, 12))).toBe(12);
    // never two within the same cycle month
    for (let k = 0; k < 24; k++) expect(within(g, addMonthsUTC(buy, k), addMonthsUTC(buy, k + 1)), `month ${k}`).toBe(1);
  });
  it("Lifetime: the purchase plus one refill a month, so 36 allowances in the first 36 months", () => {
    const buy = D("2026-01-31");
    const g = simulate("LIFETIME", buy, 1200, [buy], () => null);
    expect(within(g, buy, addMonthsUTC(buy, 36))).toBe(36);
    for (let k = 0; k < 36; k++) expect(within(g, addMonthsUTC(buy, k), addMonthsUTC(buy, k + 1)), `month ${k}`).toBe(1);
  });
  it("a plan an admin set (no payment behind it) keeps the calendar refill", () => {
    expect(refillDue({ plan: "PRO", planRenewsAt: D("2026-05-01"), lastRefillAt: D("2026-03-03"), anchor: null }, D("2026-04-01"))).toEqual({ refId: "2026-04" });
  });
  it("uses a distinct, stable ref id per cycle month, so a retried job cannot refill twice", () => {
    const s: RefillState = { plan: "LIFETIME", planRenewsAt: null, lastRefillAt: D("2026-01-10"), anchor: { at: D("2026-01-10"), ref: "pay:alt_x" } };
    expect(refillDue(s, D("2026-02-10"))).toEqual({ refId: "cycle:pay:alt_x:1" });
    expect(refillDue(s, D("2026-02-25"))).toEqual({ refId: "cycle:pay:alt_x:1" });
    expect(refillDue({ ...s, lastRefillAt: D("2026-02-11") }, D("2026-02-25"))).toBeNull();
  });
});

describe("the refill cron route (in-memory Postgres)", () => {
  let d: DB;
  beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);
  const ENV = { ...process.env };
  beforeEach(async () => {
    process.env.CRON_SECRET = "cron_secret_for_tests_0123";
    delete process.env.DATABASE_URL; delete process.env.LIFETIME_MONTHLY_CREDITS;
    await d.execute(sql`truncate users, credit_ledger, audit_log, notifications restart identity cascade`);
  });
  afterEach(() => { vi.useRealTimers(); process.env = { ...ENV }; });
  const run = async () => { const r = await refillRoute(new Request("http://x/api/cron/refill", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })); const j = await r.json(); if (r.status !== 200) console.error(j); return j as { refilled: number }; };
  const grant = (userId: string, delta: number, refId: string, createdAt: Date) => d.insert(creditLedger).values({ userId, delta, bucket: "monthly", reason: "monthly_refill", refType: "refill", refId, createdAt });

  it("refills a Lifetime member on the payment's anniversary with the Lifetime allowance, skips Pro monthly, and is idempotent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(D("2026-06-12"));
    await d.insert(users).values([
      { id: "life", email: "l@x.co", name: "L", plan: "LIFETIME", creditsMonthly: 2000 },
      { id: "pro", email: "p@x.co", name: "P", plan: "PRO", planRenewsAt: D("2026-06-14"), creditsMonthly: 6000 },
      { id: "free", email: "f@x.co", name: "F", creditsMonthly: 300 },
    ]);
    await grant("life", 2000, "pay:alt_life", D("2026-05-10")); // bought May 10: June 10 refill is due
    await grant("pro", 6000, "pay:alt_pro", D("2026-05-14")); // monthly: paid through June 14; refilled by its renewal
    await grant("free", 300, "2026-05", D("2026-05-01"));
    expect((await run()).refilled).toBe(2);
    expect((await ledgerBalance(d, "life")).monthly).toBe(2000);
    const lifeRows = await d.select().from(creditLedger).where(eq(creditLedger.userId, "life"));
    expect(lifeRows.map((r) => r.refId)).toContain("cycle:pay:alt_life:1");
    expect((await d.select().from(creditLedger).where(eq(creditLedger.userId, "pro")))).toHaveLength(1);
    expect((await run()).refilled).toBe(0);
  });
});
