import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, type DB } from "@/lib/db";
import { users, payments, subscriptions, creditLedger, studioSessions, transformations, presets, notifications, supportTickets } from "@/db/schema";
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

/**
 * Account deletion: cancel subscriptions → delete Storage files → anonymise payments (kept for accounting)
 * → hard-delete everything else → optionally delete the Clerk user.
 */
export async function deleteAccount(userId: string, opts: { deleteClerk: boolean }) {
  const d = db();
  const subs = await d.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  for (const s of subs) {
    if (s.status !== "active") continue;
    try { await getProvider(s.provider as "paystack" | "nowpayments").cancelSubscription?.(s.providerSubId, s.emailToken ?? undefined); }
    catch (e) { console.error("[delete] cancel failed", s.id, e); }
  }
  await deleteUserFiles(userId).catch((e) => console.error("[delete] storage", e));
  await d.transaction(async (tx) => {
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
