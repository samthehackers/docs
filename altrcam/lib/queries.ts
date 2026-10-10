import { and, count, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { creditLedger, payments, presets, studioSessions, subscriptions, transformations, users } from "@/db/schema";
import { db, type DB } from "@/lib/db";
import { ledgerBalance } from "@/lib/credits";
import { getPlan } from "@/lib/plan-config";
import { isLowCredit, usagePercent } from "@/lib/account-summary";
import type { Plan } from "@/lib/plans";

export const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

/**
 * Everything the dashboard shows, for ONE user: every query below is filtered on `userId`.
 * `d` is only passed by tests; the app uses the default connection (and the cached plan limits that come with it).
 */
export async function dashboardData(userId: string, plan: Plan, d?: DB) {
  const q = d ?? db();
  const since = monthStart();
  const [bal, sessions, spent, recent, presetRows, presetCount, lastPayment, activeSub] = await Promise.all([
    ledgerBalance(q, userId),
    q.select({ n: count() }).from(studioSessions).where(and(eq(studioSessions.userId, userId), gte(studioSessions.startedAt, since))),
    // Session debits this month, net of early-drop refunds (which go back to the bucket they came from), per bucket: only
    // the monthly bucket is measured against the monthly allowance.
    q.select({ bucket: creditLedger.bucket, s: sql<number>`coalesce(-sum(${creditLedger.delta}),0)::int` }).from(creditLedger)
      .where(and(eq(creditLedger.userId, userId), inArray(creditLedger.reason, ["session", "session_refund"]), gte(creditLedger.createdAt, since)))
      .groupBy(creditLedger.bucket),
    q.select().from(transformations).where(eq(transformations.userId, userId)).orderBy(desc(transformations.createdAt)).limit(6),
    q.select({ id: presets.id, name: presets.name, kind: presets.kind }).from(presets).where(eq(presets.userId, userId))
      .orderBy(desc(presets.createdAt), desc(presets.id)).limit(4),
    q.select({ n: count() }).from(presets).where(eq(presets.userId, userId)),
    q.select({ product: payments.product, amountMinor: payments.amountMinor, currency: payments.currency, createdAt: payments.createdAt }).from(payments)
      .where(and(eq(payments.userId, userId), eq(payments.status, "success"))).orderBy(desc(payments.createdAt), desc(payments.id)).limit(1),
    q.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"))).limit(1),
  ]);
  const allowance = (await getPlan(plan, d)).monthlyCredits;
  const usedMonthly = spent.find((r) => r.bucket === "monthly")?.s ?? 0;
  const usedSeconds = spent.reduce((n, r) => n + r.s, 0);
  return {
    balance: bal,
    sessionsThisMonth: sessions[0]?.n ?? 0,
    /** Credits spent on live sessions this month, from both buckets (1 credit = 1 second). */
    usedSeconds,
    /** The part of that taken from the monthly allowance. */
    usedMonthly,
    allowance,
    /** null when the plan has no monthly allowance: there is nothing to measure against. */
    usagePct: usagePercent(usedMonthly, allowance),
    lowCredits: isLowCredit(bal.total, allowance),
    recent,
    presets: presetRows,
    presetCount: presetCount[0]?.n ?? 0,
    lastPayment: lastPayment[0] ?? null,
    hasActiveSubscription: activeSub.length > 0,
  };
}

/** Characters (code points, so an emoji is never cut in half) of a session's prompt to show in the list. */
const PROMPT_PREVIEW = 120;

/**
 * The user's own recent studio sessions (date, billed seconds = credits spent, how it ended) and recent credit changes.
 * Per-heartbeat session debits are left out of the credit list: sessions are listed on their own, and a few minutes
 * of live video would otherwise push every grant, top-up and expiry out of view.
 */
export async function usageHistory(userId: string, d?: DB, limit = 8) {
  const q = d ?? db();
  const [sessions, credits] = await Promise.all([
    q.select({
      id: studioSessions.id, startedAt: studioSessions.startedAt, endedAt: studioSessions.endedAt, endReason: studioSessions.endReason,
      secondsBilled: studioSessions.secondsBilled, refundedCredits: studioSessions.refundedCredits, lastHeartbeatAt: studioSessions.lastHeartbeatAt,
      // Only the cut-down prompt leaves the database: `settings` is client-supplied and can be large.
      prompt: sql<string | null>`case when jsonb_typeof(${studioSessions.settings}->'prompt') = 'string' then left(${studioSessions.settings}->>'prompt', ${PROMPT_PREVIEW}) end`,
    }).from(studioSessions).where(eq(studioSessions.userId, userId)).orderBy(desc(studioSessions.startedAt)).limit(limit),
    q.select({ id: creditLedger.id, createdAt: creditLedger.createdAt, delta: creditLedger.delta, bucket: creditLedger.bucket, reason: creditLedger.reason })
      .from(creditLedger).where(and(eq(creditLedger.userId, userId), ne(creditLedger.reason, "session")))
      .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id)).limit(limit),
  ]);
  return {
    sessions: sessions.map((s) => ({ ...s, prompt: s.prompt || null })),
    credits,
  };
}

export async function activeUserCount() {
  const [r] = await db().select({ n: count() }).from(users);
  return r?.n ?? 0;
}
