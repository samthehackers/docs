import { and, count, eq, sql } from "drizzle-orm";
import { payments, referrals, users } from "@/db/schema";
import type { DB, Tx } from "@/lib/db";
import { grantCredits } from "@/lib/credits";
import { notify } from "@/lib/notifications";
import { REFERRAL } from "@/lib/plans";

const DAY = 86_400_000;

export type ClaimResult =
  | { status: "claimed" }
  | { status: "ignored"; reason: "bad_code" | "unknown_code" | "self" | "cycle" | "already_referred" | "too_late" | "signed_up_before_click" | "already_paid" | "no_user" };

/**
 * Attach `userId` to the owner of `code`. Idempotent and conservative: only a brand-new account that
 * hasn't paid yet can be claimed, and never by itself. Safe to call on every page load.
 */
export async function claimReferral(d: DB, userId: string, code: string, opts: { now?: Date; clickedAt?: Date } = {}): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  if (!REFERRAL.codePattern.test(code)) return { status: "ignored", reason: "bad_code" };
  return d.transaction(async (tx): Promise<ClaimResult> => {
    // Lock the friend's row so two concurrent loads can't both claim, and the code owner's row too, always in id
    // order. Locking only our own row and then touching the other's (the foreign key check does) lets two accounts
    // that claim each other at the same moment wait on each other: Postgres aborts one with a deadlock error.
    // With a fixed order the second one waits, then sees the first one's link and is refused as a cycle.
    const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.referralCode, code));
    const lockIds = owner && owner.id !== userId ? [userId, owner.id].sort() : [userId];
    for (const id of lockIds) await tx.execute(sql`select 1 from ${users} where ${users.id} = ${id} for update`);
    const [me] = await tx.select().from(users).where(eq(users.id, userId));
    if (!me || me.deletedAt) return { status: "ignored", reason: "no_user" };
    if (me.referredBy) return { status: "ignored", reason: "already_referred" };
    if (now.getTime() - me.createdAt.getTime() > REFERRAL.claimWindowDays * DAY) return { status: "ignored", reason: "too_late" };
    // The account must have been created after the link was clicked (small grace for clock skew), so an
    // existing account can't be attributed by someone later opening a link.
    if (opts.clickedAt && me.createdAt.getTime() < opts.clickedAt.getTime() - 5 * 60_000) return { status: "ignored", reason: "signed_up_before_click" };

    const [referrer] = await tx.select({ id: users.id, deletedAt: users.deletedAt, referredBy: users.referredBy }).from(users).where(eq(users.referralCode, code));
    if (!referrer || referrer.deletedAt) return { status: "ignored", reason: "unknown_code" };
    if (referrer.id === userId) return { status: "ignored", reason: "self" };
    // Keep the referral graph acyclic (A<-B<-C<-A would also deadlock concurrent payments, which lock friend
    // then referrer). Walk up the referrer's own chain; it is short, bounded and cycle-free by construction.
    for (let hop = 0, cur: string | null = referrer.referredBy; cur && hop < 25; hop++) {
      if (cur === userId) return { status: "ignored", reason: "cycle" };
      const [up] = await tx.select({ referredBy: users.referredBy }).from(users).where(eq(users.id, cur));
      cur = up?.referredBy ?? null;
    }

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

/**
 * Account deletion. Rows for a *rewarded* friend are kept with the friend detached (referred_id = NULL):
 * deleting the account must not reset the referrer's reward cap or "credits earned". Unrewarded rows are
 * deleted. Everything where the deleted user was the referrer goes, since they can't earn any more.
 */
export async function purgeReferrals(tx: Tx, userId: string) {
  await tx.update(referrals).set({ referredId: null }).where(and(eq(referrals.referredId, userId), eq(referrals.status, "rewarded")));
  await tx.delete(referrals).where(eq(referrals.referredId, userId));
  await tx.delete(referrals).where(eq(referrals.referrerId, userId));
  // Deliberately NOT touching other users' rows (users.referred_by of friends): that would take row locks in the
  // opposite order to payment fulfilment and can deadlock. referred_by has no FK; a dangling id is harmless
  // because every check that reads it compares ids and the referrals table is the source of truth.
}
