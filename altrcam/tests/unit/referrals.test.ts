import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { notifications, payments, referrals, users } from "@/db/schema";
import { fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";
import { ledgerBalance } from "@/lib/credits";
import { claimReferral, purgeReferrals, referralStats } from "@/lib/referrals";
import { makeRefCookie, parseRefCookie } from "@/lib/referral-cookie";
import { REFERRAL } from "@/lib/plans";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
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

describe("stats", () => {
  it("reports signups, rewards and credits earned", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    expect(await referralStats(d, "ref")).toMatchObject({ signedUp: 1, rewarded: 0, creditsEarned: 0, remainingRewards: REFERRAL.maxRewardsPerReferrer });
    await fulfilPayment(pay(), d);
    expect(await referralStats(d, "ref")).toMatchObject({ signedUp: 1, rewarded: 1, creditsEarned: REFERRAL.rewardCredits });
  });
});

describe("account deletion can't be used to game the cap", () => {
  const fillRewarded = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await d.insert(users).values({ id: `old${i}`, email: `old${i}@x.co` });
      await d.insert(referrals).values({ referrerId: "ref", referredId: `old${i}`, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    }
  };

  it("a rewarded friend deleting their account keeps the row (detached), so the cap and stats still count it", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    await fulfilPayment(pay(), d);
    await d.transaction((tx) => purgeReferrals(tx, "fr"));
    const rows = await d.select().from(referrals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referredId: null, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    expect(await referralStats(d, "ref")).toMatchObject({ rewarded: 1, creditsEarned: REFERRAL.rewardCredits });
  });
  it("end to end: fill the cap, delete a rewarded friend, the cap is NOT reset", async () => {
    await fillRewarded(REFERRAL.maxRewardsPerReferrer - 1);
    await claimReferral(d, "fr", "aaaaaaaa");
    await fulfilPayment(pay(), d); // the 20th reward
    expect((await referralStats(d, "ref")).remainingRewards).toBe(0);
    await d.transaction((tx) => purgeReferrals(tx, "fr")); // friend deletes their account
    expect((await referralStats(d, "ref")).remainingRewards).toBe(0);
    await d.insert(users).values({ id: "g", email: "g@x.co" });
    await claimReferral(d, "g", "aaaaaaaa");
    const before = (await ledgerBalance(d, "ref")).total;
    await fulfilPayment(pay({ userId: "g", reference: "rg", eventId: "eg" }), d);
    expect((await ledgerBalance(d, "ref")).total).toBe(before); // capped: no 21st reward
    expect((await d.select().from(referrals).where(eq(referrals.referredId, "g")))[0].status).toBe("capped");
  });
  it("an unrewarded friend deleting their account removes the row", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    await d.transaction((tx) => purgeReferrals(tx, "fr"));
    expect((await d.select().from(referrals)).length).toBe(0);
  });
  it("a referrer deleting their account removes the links they owned, without touching the friends' user rows (lock-order safety)", async () => {
    await claimReferral(d, "fr", "aaaaaaaa");
    await d.transaction((tx) => purgeReferrals(tx, "ref"));
    expect((await d.select().from(referrals)).length).toBe(0);
    // friend's users.referred_by is left as a harmless dangling id; the referrals table is the source of truth
    expect((await d.select().from(users).where(eq(users.id, "fr")))[0].referredBy).toBe("ref");
    // ...and a dangling id can't be exploited: the friend still can't be re-claimed
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toMatchObject({ reason: "already_referred" });
  });
});

describe("cap boundary", () => {
  it("a capped referral stays capped: later payments from that friend never reward", async () => {
    for (let i = 0; i < REFERRAL.maxRewardsPerReferrer; i++) {
      await d.insert(users).values({ id: `q${i}`, email: `q${i}@x.co` });
      await d.insert(referrals).values({ referrerId: "ref", referredId: `q${i}`, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    }
    await claimReferral(d, "fr", "aaaaaaaa");
    await fulfilPayment(pay(), d); // capped now
    expect((await d.select().from(referrals).where(eq(referrals.referredId, "fr")))[0].status).toBe("capped");
    await fulfilPayment(pay({ eventId: "e9", reference: "r9" }), d); // a renewal
    expect((await d.select().from(referrals).where(eq(referrals.referredId, "fr")))[0].status).toBe("capped");
    expect((await ledgerBalance(d, "ref")).total).toBe(0);
  });
  it("the last allowed reward is paid, the next one is capped", async () => {
    for (let i = 0; i < REFERRAL.maxRewardsPerReferrer - 1; i++) {
      await d.insert(users).values({ id: `p${i}`, email: `p${i}@x.co` });
      await d.insert(referrals).values({ referrerId: "ref", referredId: `p${i}`, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
    }
    await claimReferral(d, "fr", "aaaaaaaa");
    await fulfilPayment(pay(), d);
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits); // 19 rewarded before -> 20th paid
    await d.insert(users).values({ id: "z", email: "z@x.co" });
    await claimReferral(d, "z", "aaaaaaaa");
    await fulfilPayment(pay({ userId: "z", reference: "rz", eventId: "ez" }), d);
    expect((await ledgerBalance(d, "ref")).purchased).toBe(REFERRAL.rewardCredits); // 21st: nothing more
  });
});

describe("attribution rules", () => {
  it("rejects a referral ring (A referred by B, then B claims A's code)", async () => {
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toEqual({ status: "claimed" }); // fr referred by ref
    expect(await claimReferral(d, "ref", "bbbbbbbb")).toMatchObject({ status: "ignored", reason: "cycle" });
  });
  it("rejects longer rings too (A<-B<-C, then A claims C's code), keeping the graph acyclic", async () => {
    await d.insert(users).values([{ id: "c", email: "c@x.co", referralCode: "cccccccc" }, { id: "d2", email: "d2@x.co", referralCode: "dddddddd" }]);
    expect(await claimReferral(d, "fr", "aaaaaaaa")).toEqual({ status: "claimed" }); // fr <- ref
    expect(await claimReferral(d, "c", "bbbbbbbb")).toEqual({ status: "claimed" });  // c <- fr  (chain: c <- fr <- ref)
    expect(await claimReferral(d, "d2", "cccccccc")).toEqual({ status: "claimed" }); // d2 <- c  (chain length 4)
    expect(await claimReferral(d, "ref", "dddddddd")).toMatchObject({ reason: "cycle" }); // ref <- d2 would close the loop
    expect((await d.select().from(referrals).where(eq(referrals.referredId, "ref"))).length).toBe(0);
  });
  it("only attributes an account created after the click (within a small clock-skew grace)", async () => {
    const created = (await d.select().from(users).where(eq(users.id, "fr")))[0].createdAt;
    const at = (deltaMs: number) => new Date(created.getTime() + deltaMs);
    expect(await claimReferral(d, "fr", "aaaaaaaa", { clickedAt: at(+60 * 60_000) })).toMatchObject({ reason: "signed_up_before_click" }); // clicked an hour AFTER signup
    expect(await claimReferral(d, "fr", "aaaaaaaa", { clickedAt: at(+10 * 60_000) })).toMatchObject({ reason: "signed_up_before_click" });
    expect(await claimReferral(d, "fr", "aaaaaaaa", { clickedAt: at(+2 * 60_000) })).toEqual({ status: "claimed" }); // inside the 5-minute grace
  });
  it("claim window boundary: just inside OK, just outside too late", async () => {
    const day = 86_400_000 * REFERRAL.claimWindowDays;
    const created = (await d.select().from(users).where(eq(users.id, "fr")))[0].createdAt;
    expect(await claimReferral(d, "fr", "aaaaaaaa", { now: new Date(created.getTime() + day + 60_000) })).toMatchObject({ reason: "too_late" });
    expect(await claimReferral(d, "fr", "aaaaaaaa", { now: new Date(created.getTime() + day - 60_000) })).toEqual({ status: "claimed" });
  });
});

describe("referral cookie", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("round-trips a code and its click time", () => {
    const v = makeRefCookie("aaaaaaaa", now)!;
    expect(v).toBe("aaaaaaaa.1767225600");
    expect(parseRefCookie(v, now)).toEqual({ code: "aaaaaaaa", clickedAt: now });
  });
  it("refuses to make a cookie for a malformed code", () => {
    expect(makeRefCookie("nope", now)).toBeNull();
    expect(makeRefCookie("AAAAAAAA", now)).toBeNull();
  });
  it("ignores malformed, tampered, bare-code and forged-future values", () => {
    for (const bad of [undefined, "", "aaaaaaaa", "aaaaaaaa.", "aaaaaaaa.abc", "zzzzzzzz.1767225600", "aaaaaaaa.1767225600.extra", "'; drop table users;--", "aaaaaaaa.99999999999"]) {
      expect(parseRefCookie(bad, now)).toBeNull();
    }
  });
});

describe("a reward failure can never undo a customer's payment", () => {
  it("keeps the payment, plan and credits when the reward step blows up, and records it for reconciliation", async () => {
    const d2 = await testDb(); // isolated engine so we can break the referrals table without disturbing other tests
    await d2.insert(users).values([{ id: "ref", email: "ref@x.co", referralCode: "aaaaaaaa" }, { id: "fr", email: "fr@x.co", referralCode: "bbbbbbbb" }]);
    await claimReferral(d2, "fr", "aaaaaaaa");
    await d2.execute(sql`drop table referrals cascade`); // simulates a migration gap / constraint failure
    const r = await fulfilPayment(pay(), d2);
    expect(r).toBe("applied");
    expect((await d2.select().from(users).where(eq(users.id, "fr")))[0].plan).toBe("PRO");
    expect((await ledgerBalance(d2, "fr")).monthly).toBeGreaterThan(0);
    expect((await d2.select().from(payments).where(eq(payments.reference, "r1")))[0].status).toBe("success");
    const audit = await d2.execute(sql`select action from audit_log where action = 'referral.reward_failed'`);
    expect((audit as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  }, 60_000);
});
