import { and, eq, isNull, lt } from "drizzle-orm";
import { studioSessions, users } from "@/db/schema";
import { db } from "@/lib/db";
import { debitCredits, ledgerBalance } from "@/lib/credits";
import { computeMeter } from "@/lib/credits-math";
import { LOW_CREDIT_RATIO, STALE_AFTER_SECONDS } from "@/lib/plans";
import { getPlan } from "@/lib/plan-config";
import { notify, userEmailIfEnabled } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import { sql } from "drizzle-orm";

export interface Stats { fps?: number; rttMs?: number }
export interface MeterOut { remaining: number; continue: boolean; reason?: string; secondsLeftInSession: number; secondsBilled: number }

/**
 * Bill a session up to `now` (server clock) and close it when credits or the plan limit run out.
 * Row-locked, so concurrent heartbeats cannot double-bill.
 */
export async function meterSession(sessionId: string, userId: string, o: { now?: Date; end?: string; stats?: Stats } = {}): Promise<MeterOut | null> {
  const now = o.now ?? new Date();
  const out = await db().transaction(async (tx) => {
    // Ownership is part of the lookup: another user's session id returns nothing.
    const [s] = await tx.execute<{ id: string }>(sql`select id from ${studioSessions} where id = ${sessionId} and user_id = ${userId} for update`);
    if (!s) return null;
    const [row] = await tx.select().from(studioSessions).where(eq(studioSessions.id, sessionId));
    const bal = await ledgerBalance(tx, userId);
    if (row.endedAt) return { remaining: bal.total, continue: false, reason: row.endReason ?? "ended", secondsLeftInSession: 0, secondsBilled: row.secondsBilled, ended: true as const };

    const m = computeMeter({ startedAt: row.startedAt, now, secondsBilled: row.secondsBilled, maxSeconds: row.maxSeconds, balance: bal.total });
    if (m.debit > 0) await debitCredits(tx, userId, m.debit, "session", { type: "session", id: sessionId });

    const n = Math.max(1, Math.floor(row.secondsBilled / 10));
    const avg = (prev: number | null, x: number | undefined) => (x === undefined ? prev : prev === null ? x : (prev * n + x) / (n + 1));
    const endReason = o.end ?? (m.continue ? undefined : m.reason);
    await tx.update(studioSessions).set({
      secondsBilled: m.secondsBilled,
      lastHeartbeatAt: o.end === "stale" ? row.lastHeartbeatAt : now,
      avgFps: avg(row.avgFps, o.stats?.fps),
      avgLatencyMs: avg(row.avgLatencyMs, o.stats?.rttMs),
      ...(endReason ? { endedAt: now, endReason } : {}),
    }).where(eq(studioSessions.id, sessionId));

    return { remaining: m.remaining, continue: m.continue && !o.end, reason: endReason, secondsLeftInSession: m.secondsLeftInSession, secondsBilled: m.secondsBilled, ended: false as const };
  });
  if (!out) return null;
  if (!out.ended) await maybeLowCreditAlert(userId, out.remaining).catch((e) => console.error("[low-credit]", e));
  return out;
}

/** In-app + email alert once per day when the total balance drops under 10% of the plan allowance. */
async function maybeLowCreditAlert(userId: string, remaining: number) {
  const d = db();
  const [u] = await d.select({ plan: users.plan, at: users.lowCreditNotifiedAt }).from(users).where(eq(users.id, userId));
  if (!u) return;
  if (remaining >= (await getPlan(u.plan)).monthlyCredits * LOW_CREDIT_RATIO) return;
  if (u.at && Date.now() - u.at.getTime() < 86_400_000) return;
  const claimed = await d.update(users).set({ lowCreditNotifiedAt: new Date() })
    .where(and(eq(users.id, userId), sql`(${users.lowCreditNotifiedAt} is null or ${users.lowCreditNotifiedAt} < now() - interval '1 day')`)).returning({ id: users.id });
  if (!claimed.length) return;
  await notify(d, userId, "low_credits", "Running low on credits", `${remaining} credits left.`);
  const to = await userEmailIfEnabled(d, userId);
  if (to) await sendEmail(to, "You're low on AltrCam credits", `<p>You have <b>${remaining}</b> credits left. <a href="${process.env.NEXT_PUBLIC_APP_URL}/billing">Top up</a> to keep going live.</p>`);
}

/** Close sessions whose heartbeat stopped; billed only up to the last heartbeat. */
export async function sweepStaleSessions(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const stale = await db().select({ id: studioSessions.id, userId: studioSessions.userId, last: studioSessions.lastHeartbeatAt })
    .from(studioSessions).where(and(isNull(studioSessions.endedAt), lt(studioSessions.lastHeartbeatAt, cutoff)));
  for (const s of stale) await meterSession(s.id, s.userId, { now: s.last, end: "stale" });
  return stale.length;
}

/** The user's open session (if any), used by the fal proxy gate. */
export async function activeSession(sessionId: string, userId: string) {
  const [s] = await db().select({ id: studioSessions.id }).from(studioSessions)
    .where(and(eq(studioSessions.id, sessionId), eq(studioSessions.userId, userId), isNull(studioSessions.endedAt)));
  return !!s;
}
