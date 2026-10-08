import { and, count, eq, sql } from "drizzle-orm";
import { payments, referrals, users } from "@/db/schema";
import type { DB, Tx } from "@/lib/db";
import { grantCredits } from "@/lib/credits";
import { notify } from "@/lib/notifications";
import { REFERRAL } from "@/lib/plans";

const DAY = 86_400_000;

export type ClaimResult =
  | { status: "claimed" }
  | { status: "ignored"; reason: "bad_code" | "unknown_code" | "self" | "already_referred" | "too_late" | "already_paid" | "no_user" };

/**
 * Attach `userId` to the owner of `code`. Idempotent and conservative: only a brand-new account that
 * hasn't paid yet can be claimed, and never by itself. Safe to call on every page load.
 */
export async function claimReferral(d: DB, userId: string, code: string, now = new Date()): Promise<ClaimResult> {
  if (!REFERRAL.codePattern.test(code)) return { status: "ignored", reason: "bad_code" };
  return d.transaction(async (tx): Promise<ClaimResult> => {
    // Lock the friend's row so two concurrent loads can't both claim.
    await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
    const [me] = await tx.select().from(users).where(eq(users.id, userId));
    if (!me || me.deletedAt) return { status: "ignored", reason: "no_user" };
    if (me.referredBy) return { status: "ignored", reason: "already_referred" };
    if (now.getTime() - me.createdAt.getTime() > REFERRAL.claimWindowDays * DAY) return { status: "ignored", reason: "too_late" };

    const [referrer] = await tx.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.referralCode, code));
    if (!referrer || referrer.deletedAt) return { status: "ignored", reason: "unknown_code" };
    if (referrer.id === userId) return { status: "ignored", reason: "self" };

    const [paid] = await tx.select({ n: count() }).from(payments).where(and(eq(payments.userId, userId), eq(payments.status, "success")));
    if ((paid?.n ?? 0) > 0) return { status: "ignored", reason: "already_paid" };

    const ins = await tx.insert(referrals).values({ referrerId: referrer.id, referredId: userId }).onConflictDoNothing().returning({ id: referrals.id });
    if (!ins.length) return { status: "ignored", reason: "already_referred" };
    await tx.update(users).set({ referredBy: referrer.id }).where(eq(users.id, userId));
    return { status: "claimed" };
  });
}

/**
 * Called inside the payment fulfilment transaction. Rewards the referrer once, on the friend's first
 * Pro/Lifetime payment. Fulfilment only reaches here on the pending→success payment transition, and the
 * referral row flips pending→rewarded atomically, so replays and double deliveries can't pay twice.
 */
export async function rewardReferrer(tx: Tx, referredId: string, paymentKind: string) {
  if (!(REFERRAL.rewardKinds as readonly string[]).includes(paymentKind)) return null;

  const [r] = await tx.select().from(referrals).where(and(eq(referrals.referredId, referredId), eq(referrals.status, "pending")));
  if (!r) return null;

  // Serialise per referrer so the cap can't be raced past.
  await tx.execute(sql`select 1 from ${users} where ${users.id} = ${r.referrerId} for update`);
  const [done] = await tx.select({ n: count() }).from(referrals).where(and(eq(referrals.referrerId, r.referrerId), eq(referrals.status, "rewarded")));

  if ((done?.n ?? 0) >= REFERRAL.maxRewardsPerReferrer) {
    await tx.update(referrals).set({ status: "capped" }).where(and(eq(referrals.id, r.id), eq(referrals.status, "pending")));
    return null;
  }
  const flipped = await tx.update(referrals)
    .set({ status: "rewarded", rewardCredits: REFERRAL.rewardCredits, rewardedAt: new Date() })
    .where(and(eq(referrals.id, r.id), eq(referrals.status, "pending")))
    .returning({ id: referrals.id });
  if (!flipped.length) return null;

  await grantCredits(tx, r.referrerId, REFERRAL.rewardCredits, "purchased", "referral_reward", { type: "referral", id: referredId });
  await notify(tx, r.referrerId, "referral", "Referral reward", `A friend you invited upgraded. ${REFERRAL.rewardCredits} credits were added to your account.`);
  return { referrerId: r.referrerId, credits: REFERRAL.rewardCredits };
}

export async function referralStats(d: DB, userId: string) {
  const rows = await d.select({ status: referrals.status, n: count(), credits: sql<number>`coalesce(sum(${referrals.rewardCredits}),0)::int` })
    .from(referrals).where(eq(referrals.referrerId, userId)).groupBy(referrals.status);
  const get = (s: string) => rows.find((r) => r.status === s);
  return {
    signedUp: rows.reduce((a, r) => a + r.n, 0),
    rewarded: get("rewarded")?.n ?? 0,
    creditsEarned: get("rewarded")?.credits ?? 0,
    remainingRewards: Math.max(0, REFERRAL.maxRewardsPerReferrer - (get("rewarded")?.n ?? 0)),
  };
}

/** Account deletion: drop referral links in both directions (credits already granted stay in the ledger until it is purged). */
export async function purgeReferrals(tx: Tx, userId: string) {
  await tx.delete(referrals).where(eq(referrals.referredId, userId));
  await tx.delete(referrals).where(eq(referrals.referrerId, userId));
  await tx.update(users).set({ referredBy: null }).where(eq(users.referredBy, userId));
}
