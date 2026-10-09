import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, payments, users } from "@/db/schema";
import { downgradeExpired, fulfilPayment, recordRejected } from "@/lib/payments/fulfil";
import { grantCredits, ledgerBalance, debitCredits, resetMonthly } from "@/lib/credits";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
  await d.insert(users).values({ id: "u1", email: "a@b.co", name: "A" });
});

const base = {
  provider: "paystack" as const, eventId: "e1", eventType: "charge.success", payload: {},
  reference: "ref1", userId: "u1", product: "TOPUP_1K" as const, amountMinor: 300000, currency: "NGN",
};

describe("fulfilment idempotency", () => {
  it("same webhook twice = one grant", async () => {
    expect(await fulfilPayment(base, d)).toBe("applied");
    expect(await fulfilPayment(base, d)).toBe("duplicate");
    expect((await ledgerBalance(d, "u1")).purchased).toBe(1000);
  });
  it("different event ids for the same reference still grant once", async () => {
    await fulfilPayment(base, d);
    expect(await fulfilPayment({ ...base, eventId: "e2" }, d)).toBe("already_paid");
    expect((await ledgerBalance(d, "u1")).purchased).toBe(1000);
  });
  it("PRO purchase sets plan and resets monthly bucket; purchased survives", async () => {
    await grantCredits(d, "u1", 50, "monthly", "signup");
    await grantCredits(d, "u1", 200, "purchased", "topup");
    await fulfilPayment({ ...base, reference: "r2", eventId: "e3", product: "PRO_MONTHLY", amountMinor: 1500000 }, d);
    const [u] = await d.select().from(users).where(eq(users.id, "u1"));
    expect(u.plan).toBe("PRO");
    expect(await ledgerBalance(d, "u1")).toMatchObject({ monthly: 6000, purchased: 200 });
    expect(u.creditsMonthly).toBe(6000); // cache matches ledger
  });
  it("LIFETIME never expires", async () => {
    await fulfilPayment({ ...base, reference: "r3", eventId: "e4", product: "LIFETIME", amountMinor: 45000000 }, d);
    expect(await downgradeExpired(d, new Date("2100-01-01"))).toBe(0);
  });
  it("rejected payments grant nothing", async () => {
    await recordRejected({ ...base, amountMinor: 1 }, "mismatch", d);
    expect((await ledgerBalance(d, "u1")).total).toBe(0);
    const [p] = await d.select().from(payments).where(eq(payments.reference, "ref1"));
    expect(p.status).toBe("rejected");
  });
  it("lapsed PRO downgrades to FREE and keeps purchased credits", async () => {
    await fulfilPayment({ ...base, reference: "r4", eventId: "e5", product: "TOPUP_5K", amountMinor: 1200000 }, d);
    await d.update(users).set({ plan: "PRO", planRenewsAt: new Date("2020-01-01") }).where(eq(users.id, "u1"));
    expect(await downgradeExpired(d)).toBe(1);
    const [u] = await d.select().from(users).where(eq(users.id, "u1"));
    expect(u.plan).toBe("FREE");
    expect((await ledgerBalance(d, "u1")).purchased).toBe(5000);
  });
});

describe("ledger", () => {
  it("debits monthly before purchased and writes append-only rows", async () => {
    await grantCredits(d, "u1", 5, "monthly", "g");
    await grantCredits(d, "u1", 10, "purchased", "g");
    const r = await d.transaction((tx) => debitCredits(tx, "u1", 8, "session"));
    expect(r).toMatchObject({ debited: 8, monthly: 5, purchased: 3 });
    expect(await ledgerBalance(d, "u1")).toMatchObject({ monthly: 0, purchased: 7 });
    const rows = await d.select().from(creditLedger);
    expect(rows.length).toBe(4);
  });
  it("never overdraws", async () => {
    await grantCredits(d, "u1", 3, "monthly", "g");
    const r = await d.transaction((tx) => debitCredits(tx, "u1", 10, "session"));
    expect(r.debited).toBe(3);
    expect((await ledgerBalance(d, "u1")).total).toBe(0);
  });
  it("monthly reset expires unused monthly, not purchased", async () => {
    await grantCredits(d, "u1", 40, "monthly", "g");
    await grantCredits(d, "u1", 9, "purchased", "g");
    await d.transaction((tx) => resetMonthly(tx, "u1", 300, "2025-02"));
    expect(await ledgerBalance(d, "u1")).toMatchObject({ monthly: 300, purchased: 9 });
  });
});
