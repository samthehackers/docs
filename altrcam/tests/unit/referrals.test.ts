import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { notifications, payments, referrals, users } from "@/db/schema";
import { fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";
import { ledgerBalance } from "@/lib/credits";
import { claimReferral, purgeReferrals, referralStats } from "@/lib/referrals";
import { REFERRAL } from "@/lib/plans";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
  process.env.PRICE_CURRENCY = "NGN";
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, referrals restart identity cascade`);
  await d.insert(users).values([
    { id: "ref", email: "ref@x.co", referralCode: "aaaaaaaa" },
    { id: "fr", email: "fr@x.co", referralCode: "bbbbbbbb" },
  ]);
});

const pay = (over: Partial<FulfilInput> = {}): FulfilInput => ({
  provider: "paystack", eventId: "e1", eventType: "charge.success", payload: {},
  reference: "r1", userId: "fr", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", ...over,
});

describe("claimReferral", () => {
  it("links a new account to the code owner", async () => {
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toEqual({ status: "claimed" });
    const [u] = await d.select().from(users).where(eq(users.id, "fr"));
    expect(u.referredBy).toBe("ref");
    expect((await d.select().from(referrals)).length).toBe(1);
  });
  it("is idempotent", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toMatchObject({ status: "ignored", reason: "already_referred" });
    expect((await d.select().from(referrals)).length).toBe(1);
  });
  it("first referrer wins", async () => {
    await d.insert(users).values({ id: "ref2", email: "r2@x.co", referralCode: "cccccccc" });
    await claimReferral(d, "fr", "aaaaaaaa");
    expect(await claimReferral(d, "fr", "cccccccc")).toMatchObject({ reason: "already_referred" });
    const [u] = await d.select().from(users).where(eq(users.id, "fr"));
    expect(u.referredBy).toBe("ref");
  });
  it("rejects self-referral, malformed and unknown codes", async () => {
    expect(await claimReferral(d, "fr", "bbbbbbbb")).toMatchObject({ reason: "self" });
    expect(await claimReferral(d, "fr", "nope")).toMatchObject({ reason: "bad_code" });
    expect(await claimReferral(d, "fr", "'; drop table users;--")).toMatchObject({ reason: "bad_code" });
    expect(await claimReferral(d, "fr", "dddddddd")).toMatchObject({ reason: "unknown_code" });
    expect((await d.select().from(referrals)).length).toBe(0);
  });
  it("rejects accounts older than the claim window", async () => {
    await d.update(users).set({ createdAt: new Date(Date.now() - (REFERRAL.claimWindowDays + 1) * 86_400_000) }).where(eq(users.id, "fr"));
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toMatchObject({ reason: "too_late" });
  });
  it("rejects users who already paid (can't back-date a referral)", async () => {
    await fulfilPayment(pay({ product: "TOPUP_1K", amountMinor: 300000 }), d);
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toMatchObject({ reason: "already_paid" });
  });
  it("rejects a deleted referrer", async () => {
    await d.update(users).set({ deletedAt: new Date() }).where(eq(users.id, "ref"));
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toMatchObject({ reason: "unknown_code" });
  });
});

describe("referrer reward", () => {
  beforeEach(async () => { await claimReferral(d, "fr", "aaaaaaaa"); });

  it("pays the referrer once, in the purchased bucket, on the friend's first Pro payment", async () => {
    await fulfilPayment(pay(), d);
    expect(await ledgerBalance(d, "ref")).toMatchObject({ purchased: REFERRAL.rewardCredits, monthly: 0 });
    const [r] = await d.select().from(referrals);
    expect(r).toMatchObject({ status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    expect((await d.select().from(notifications).where(eq(notifications.userId, "ref"))).length).toBe(1);
  });
  it("replaying the same webhook doesn't pay twice", async () => {
    await fulfilPayment(pay(), d);
    await fulfilPayment(pay(), d);
    await fulfilPayment(pay({ eventId: "e2" }), d); // same reference, different event id
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits);
  });
  it("a renewal (new payment) doesn't pay again", async () => {
    await fulfilPayment(pay(), d);
    await fulfilPayment(pay({ eventId: "e3", reference: "r2" }), d);
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits);
  });
  it("a top-up doesn't trigger the reward, but a later Pro payment still does", async () => {
    await fulfilPayment(pay({ product: "TOPUP_1K", amountMinor: 300000 }), d);
    expect((await ledgerBalance(d, "ref")).total).toBe(0);
    expect((await d.select().from(referrals))[0].status).toBe("pending");
    await fulfilPayment(pay({ eventId: "e4", reference: "r3" }), d);
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits);
  });
  it("Lifetime also counts", async () => {
    await fulfilPayment(pay({ product: "LIFETIME", amountMinor: 45000000 }), d);
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits);
  });
  it("a payment with no referrer rewards nobody", async () => {
    await d.insert(users).values({ id: "solo", email: "s@x.co" });
    await fulfilPayment(pay({ userId: "solo", reference: "rs", eventId: "es" }), d);
    expect((await ledgerBalance(d, "ref")).total).toBe(0);
  });
  it("stops at the per-referrer cap and marks the extra referral capped", async () => {
    for (let i = 0; i < REFERRAL.maxRewardsPerReferrer; i++) {
      await d.insert(users).values({ id: `f${i}`, email: `f${i}@x.co` });
      await d.insert(referrals).values({ referrerId: "ref", referredId: `f${i}`, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    }
    await fulfilPayment(pay(), d);
    expect((await ledgerBalance(d, "ref")).total).toBe(0);
    expect((await d.select().from(referrals).where(eq(referrals.referredId, "fr")))[0].status).toBe("capped");
  });
  it("a rejected payment (amount mismatch) pays nothing", async () => {
    const { recordRejected } = await import("@/lib/payments/fulfil");
    await recordRejected({ ...pay({ amountMinor: 1 }) }, "mismatch", d);
    expect((await ledgerBalance(d, "ref")).total).toBe(0);
    expect((await d.select().from(payments).where(eq(payments.reference, "r1")))[0].status).toBe("rejected");
  });
});

describe("stats and deletion", () => {
  it("reports signups, rewards and credits earned", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    expect(await referralStats(d, "ref")).toMatchObject({ signedUp: 1, rewarded: 0, creditsEarned: 0, remainingRewards: REFERRAL.maxRewardsPerReferrer });
    await fulfilPayment(pay(), d);
    expect(await referralStats(d, "ref")).toMatchObject({ signedUp: 1, rewarded: 1, creditsEarned: REFERRAL.rewardCredits });
  });
  it("purge removes links in both directions and clears referredBy", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    await d.transaction((tx) => purgeReferrals(tx, "ref"));
    expect((await d.select().from(referrals)).length).toBe(0);
    expect((await d.select().from(users).where(eq(users.id, "fr")))[0].referredBy).toBeNull();
  });
});
