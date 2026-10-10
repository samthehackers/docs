import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, type DB } from "@/lib/db";
import { auditLog, users, payments, subscriptions, creditLedger, studioSessions, transformations, presets, notifications, supportTickets } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import { getPlan } from "@/lib/plan-config";
import { deleteUserFiles } from "@/lib/storage";
import { getProvider } from "@/lib/payments";
import { clerkClient } from "@clerk/nextjs/server";
import { purgeReferrals } from "@/lib/referrals";

export interface ProfileInput { id: string; email: string; name: string; avatarUrl?: string | null }

/** Idempotent: inserts the user once and grants signup credits once. */
export async function provisionUser(p: ProfileInput, d: DB = db()) {
  const signupCredits = (await getPlan("FREE", d)).monthlyCredits; // follows the admin-configured FREE allowance
  return d.transaction(async (tx) => {
    const inserted = await tx.insert(users).values({
      id: p.id, email: p.email, name: p.name, avatarUrl: p.avatarUrl ?? null,
      referralCode: randomBytes(4).toString("hex"),
    }).onConflictDoNothing().returning({ id: users.id });
    if (inserted.length && signupCredits > 0) await grantCredits(tx, p.id, signupCredits, "monthly", "signup_grant", { type: "signup", id: p.id });
    return inserted.length > 0;
  });
}

export async function syncProfile(p: ProfileInput, d: DB = db()) {
  await d.update(users).set({ email: p.email, name: p.name, avatarUrl: p.avatarUrl ?? null }).where(eq(users.id, p.id));
}

/** The payment provider would not cancel a subscription, so deleting the account now would leave it billing a deleted account. */
export class SubscriptionCancelError extends Error {
  constructor(public failed: { provider: string; subscription: string }[]) { super("could not cancel the subscription at the payment provider"); }
}

/**
 * Account deletion: cancel subscriptions → delete Storage files → anonymise payments (kept for accounting)
 * → hard-delete everything else → optionally delete the sign-in account.
 *
 * If the provider refuses to cancel an active subscription: a person deleting their own account ("abort", the default when
 * the sign-in account is deleted here too) gets SubscriptionCancelError BEFORE anything is deleted, so they can retry or ask
 * support. When the sign-in account is already gone (the auth provider's user.deleted webhook, "audit"), deletion goes ahead
 * and an audit entry records the subscription for manual cancellation.
 */
export async function deleteAccount(userId: string, opts: { deleteClerk: boolean; onCancelFailure?: "abort" | "audit" }) {
  const d = db();
  const mode = opts.onCancelFailure ?? (opts.deleteClerk ? "abort" : "audit");
  const subs = await d.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const failed: { provider: string; subscription: string; error: string }[] = [];
  for (const s of subs) {
    if (s.status !== "active") continue;
    try { await getProvider(s.provider as "paystack" | "nowpayments").cancelSubscription?.(s.providerSubId, s.emailToken ?? undefined); }
    catch (e) {
      console.error("[delete] cancel failed", s.id, e instanceof Error ? e.message : e);
      failed.push({ provider: s.provider, subscription: s.providerSubId, error: String(e instanceof Error ? e.message : e).slice(0, 200) });
    }
  }
  if (failed.length && mode === "abort") throw new SubscriptionCancelError(failed.map(({ provider, subscription }) => ({ provider, subscription })));
  if (failed.length) {
    await d.insert(auditLog).values({ actorId: "system", action: "account_delete.subscription_cancel_failed", target: userId, meta: { failed, note: "account deleted; cancel this subscription at the provider by hand" } });
  }
  await deleteUserFiles(userId).catch((e) => console.error("[delete] storage", e));
  await d.transaction(async (tx) => {
    // Lock order matters: payment fulfilment locks the payment row and metering locks the session row BEFORE they touch
    // the user row, so this transaction touches payments and sessions first and the user row last. Taking the user row
    // lock first (an earlier version did) deadlocks with a heartbeat or a payment confirmed at the same moment.
    // tests/integration/delete-account.pg.test.ts runs these races on a real PostgreSQL.
    await tx.update(payments).set({ userId: null, raw: null }).where(eq(payments.userId, userId));
    await purgeReferrals(tx, userId);
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    await tx.delete(supportTickets).where(eq(supportTickets.userId, userId));
    await tx.delete(transformations).where(eq(transformations.userId, userId));
    await tx.delete(presets).where(eq(presets.userId, userId));
    await tx.delete(studioSessions).where(eq(studioSessions.userId, userId));
    await tx.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await tx.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
  if (opts.deleteClerk) {
    try { await (await clerkClient()).users.deleteUser(userId); } catch (e) { console.error("[delete] clerk", e); }
  }
}

export async function getUserRow(userId: string, d: DB = db()) {
  const [u] = await d.select().from(users).where(eq(users.id, userId));
  return u && !u.deletedAt ? u : null;
}

/** Row for the signed-in user; self-heals if the Clerk webhook has not landed yet. */
export async function ensureUserRow(userId: string, profile: () => Promise<ProfileInput>) {
  const existing = await getUserRow(userId);
  if (existing) return existing;
  await provisionUser(await profile());
  return getUserRow(userId);
}

export { sql };
