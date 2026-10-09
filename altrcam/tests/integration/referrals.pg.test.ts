/**
 * Referral rules against a REAL PostgreSQL through the production postgres-js driver.
 *
 * The unit suite (tests/unit/referrals.test.ts) runs the same rules on an in-memory Postgres. Referrals depend on
 * row locks, savepoints and races between concurrent requests, which is exactly where the two drivers differ, and a
 * referral reward is free credits, so these paths are re-checked here with real concurrency.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so use a scratch database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
if (URL_) { process.env.DATABASE_URL = URL_; }

import { db } from "@/lib/db";
import { referrals, users } from "@/db/schema";
import { ledgerBalance } from "@/lib/credits";
import { fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";
import { claimReferral, purgeReferrals } from "@/lib/referrals";
import { REFERRAL } from "@/lib/plans";

const CODE = (n: number) => n.toString(16).padStart(8, "0"); // matches REFERRAL.codePattern

suite("referrals on real PostgreSQL (production driver)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, prepare: false });
    await migrate(drizzle(admin), { migrationsFolder: "db/migrations" });
  });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    await db().execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, referrals restart identity cascade`);
  });

  const user = (id: string, n: number) => db().insert(users).values({ id, email: `${id}@x.co`, name: id, referralCode: CODE(n) });
  const pay = (userId: string, over: Partial<FulfilInput> = {}): FulfilInput => ({
    provider: "paystack", eventId: `e-${userId}`, eventType: "charge.success", payload: {},
    reference: `r-${userId}`, userId, product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", ...over,
  });
  const rewardedCount = async (referrerId: string) =>
    (await db().select().from(referrals).where(eq(referrals.referrerId, referrerId))).filter((r) => r.status === "rewarded").length;

  it("six simultaneous claims by the same new account create exactly one referral", async () => {
    await user("ref", 1); await user("fr", 2);
    const results = await Promise.all(Array.from({ length: 6 }, () => claimReferral(db(), "fr", CODE(1))));
    expect(results.filter((r) => r.status === "claimed")).toHaveLength(1);
    expect(await db().select().from(referrals)).toHaveLength(1);
    const [u] = await db().select().from(users).where(eq(users.id, "fr"));
    expect(u.referredBy).toBe("ref");
  });

  it("a referrer is paid once when the friend's payment is delivered many times at once", async () => {
    await user("ref", 1); await user("fr", 2);
    await claimReferral(db(), "fr", CODE(1));
    const same = await Promise.all(Array.from({ length: 6 }, () => fulfilPayment(pay("fr"))));
    expect(same.filter((r) => r === "applied")).toHaveLength(1);
    // the same payment reference under different event ids must not pay again either
    await Promise.all(Array.from({ length: 4 }, (_, i) => fulfilPayment(pay("fr", { eventId: `other-${i}` }))));
    expect((await ledgerBalance(db(), "ref")).purchased).toBe(REFERRAL.rewardCredits);
    expect(await rewardedCount("ref")).toBe(1);
  });

  it("top-ups never reward, and a friend's second purchase does not reward again", async () => {
    await user("ref", 1); await user("fr", 2);
    await claimReferral(db(), "fr", CODE(1));
    await fulfilPayment(pay("fr", { product: "TOPUP_1K", amountMinor: 300000, reference: "topup", eventId: "t" }));
    expect((await ledgerBalance(db(), "ref")).purchased).toBe(0);
    await fulfilPayment(pay("fr"));
    await fulfilPayment(pay("fr", { reference: "second", eventId: "second" }));
    expect((await ledgerBalance(db(), "ref")).purchased).toBe(REFERRAL.rewardCredits);
  });

  it("the per-referrer cap cannot be raced past by simultaneous payments", async () => {
    await user("ref", 1);
    const extra = 5, friends = REFERRAL.maxRewardsPerReferrer + extra;
    for (let i = 0; i < friends; i++) { await user(`f${i}`, 100 + i); await claimReferral(db(), `f${i}`, CODE(1)); }
    await Promise.all(Array.from({ length: friends }, (_, i) => fulfilPayment(pay(`f${i}`))));
    expect(await rewardedCount("ref")).toBe(REFERRAL.maxRewardsPerReferrer);
    expect((await db().select().from(referrals)).filter((r) => r.status === "capped")).toHaveLength(extra);
    expect((await ledgerBalance(db(), "ref")).purchased).toBe(REFERRAL.maxRewardsPerReferrer * REFERRAL.rewardCredits);
  }, 60_000);

  it("two accounts claiming each other at the same moment get exactly one link, never a loop or a deadlock", async () => {
    // A cycle would also make concurrent payments lock in opposite orders and deadlock.
    for (let round = 0; round < 8; round++) {
      await db().execute(sql`truncate users, payments, webhook_events, credit_ledger, notifications, referrals restart identity cascade`);
      await user("a", 1); await user("b", 2);
      // Must not throw (it used to hit "deadlock detected"): one claim wins, the other is refused as a cycle.
      const results = await Promise.all([claimReferral(db(), "a", CODE(2)), claimReferral(db(), "b", CODE(1))]);
      const claimed = results.filter((r) => r.status === "claimed");
      const refused = results.filter((r) => r.status === "ignored");
      expect(claimed, `round ${round}: ${JSON.stringify(results)}`).toHaveLength(1);
      expect(refused[0], `round ${round}`).toMatchObject({ reason: "cycle" });
      expect(await db().select().from(referrals)).toHaveLength(1);
    }
  }, 60_000);

  it("deleting a rewarded friend keeps the referrer's reward count; an unrewarded friend's row goes", async () => {
    await user("ref", 1); await user("paid", 2); await user("idle", 3);
    await claimReferral(db(), "paid", CODE(1)); await claimReferral(db(), "idle", CODE(1));
    await fulfilPayment(pay("paid"));
    await db().transaction(async (tx) => { await purgeReferrals(tx, "paid"); await purgeReferrals(tx, "idle"); });
    const rows = await db().select().from(referrals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ referrerId: "ref", referredId: null, status: "rewarded", rewardCredits: REFERRAL.rewardCredits });
  });
});
