import { and, count, desc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";
import { auditLog, studioSessions, users } from "@/db/schema";
import { db, type Tx } from "@/lib/db";
import { debitCredits, ledgerBalance, refundSessionDebits } from "@/lib/credits";
import { computeMeter } from "@/lib/credits-math";
import {
  CONNECT_GRACE_SECONDS, EARLY_DROP_SECONDS, LOW_CREDIT_RATIO, NEVER_LIVE_LIMIT, NEVER_LIVE_WINDOW_SECONDS, REFUNDABLE_FAILURES, REFUNDS_PER_DAY,
  STALE_AFTER_SECONDS,
} from "@/lib/plans";
import { getPlan } from "@/lib/plan-config";
import { notify, userEmailIfEnabled } from "@/lib/notifications";
import { sendEmail } from "@/lib/email";
import { sql } from "drizzle-orm";

export interface Stats { fps?: number; rttMs?: number }
export interface MeterOut {
  remaining: number; continue: boolean; reason?: string; secondsLeftInSession: number; secondsBilled: number;
  /** Credits given back because the session dropped early for a connection or AI-service failure (0 if none). */
  refunded: number;
}

/**
 * Bill a session up to `now` (server clock) and close it when credits or the plan limit run out.
 * Only LIVE time is billed: from live_at (the first transformed frame, POST /live) to `now`, minus what was already
 * billed. A session that never went live owes nothing on every path that comes through here (heartbeat, end,
 * supersede on a new start, stale sweep). Row-locked, and the debit is in the same transaction, so concurrent
 * heartbeats cannot double-bill.
 */
export async function meterSession(sessionId: string, userId: string, o: { now?: Date; end?: string; stats?: Stats; failure?: string } = {}): Promise<MeterOut | null> {
  const now = o.now ?? new Date();
  const out = await db().transaction(async (tx) => {
    // Ownership is part of the lookup: another user's session id returns nothing.
    const [s] = await tx.select({ id: studioSessions.id }).from(studioSessions)
      .where(and(eq(studioSessions.id, sessionId), eq(studioSessions.userId, userId))).for("update");
    if (!s) return null;
    const [row] = await tx.select().from(studioSessions).where(eq(studioSessions.id, sessionId));
    const bal = await ledgerBalance(tx, userId);
    // Already closed: nothing more is billed or refunded. A refund made when it closed is reported again, for a retried end call.
    if (row.endedAt) return { remaining: bal.total, continue: false, reason: row.endReason ?? "ended", secondsLeftInSession: 0, secondsBilled: row.secondsBilled, refunded: row.refundedCredits, debited: false };
    const failureCode = o.end === "connection_failed" && o.failure ? o.failure : undefined;

    if (!row.liveAt) {
      // Still connecting (no transformed frame yet): nothing is owed, so nothing is debited, whatever closes it. One that
      // has had CONNECT_GRACE_SECONDS, or that is closed because something failed, is recorded as failed_connect.
      const endReason = neverLiveEndReason(row.startedAt, now, o.end);
      await tx.update(studioSessions).set({
        lastHeartbeatAt: o.end === "stale" ? row.lastHeartbeatAt : now,
        ...(endReason ? { endedAt: now, endReason } : {}),
        ...(failureCode ? { failureCode } : {}),
      }).where(eq(studioSessions.id, sessionId));
      return { remaining: bal.total, continue: !endReason, reason: endReason, secondsLeftInSession: row.maxSeconds, secondsBilled: row.secondsBilled, refunded: 0, debited: false };
    }

    const m = computeMeter({ liveAt: row.liveAt, now, secondsBilled: row.secondsBilled, maxSeconds: row.maxSeconds, balance: bal.total });
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
      ...(failureCode ? { failureCode } : {}),
    }).where(eq(studioSessions.id, sessionId));

    // A drop in the first seconds of live time, for a failure on the connection or the AI service: give the charge back.
    const refunded = failureCode && isEarlyDrop(row.liveAt, now, failureCode)
      ? await refundEarlyDrop(tx, userId, sessionId, { now, failure: failureCode, liveMs: now.getTime() - row.liveAt.getTime() })
      : 0;

    return { remaining: m.remaining + refunded, continue: m.continue && !o.end, reason: endReason, secondsLeftInSession: m.secondsLeftInSession, secondsBilled: m.secondsBilled, refunded, debited: m.debit > 0 };
  });
  if (!out) return null;
  if (out.debited) await maybeLowCreditAlert(userId, out.remaining).catch((e) => console.error("[low-credit]", e));
  return out;
}

const REFUNDABLE = new Set<string>(REFUNDABLE_FAILURES);

/** Ended for a connection or AI-service failure within EARLY_DROP_SECONDS of going live (server clock). */
export function isEarlyDrop(liveAt: Date, now: Date, failure: string) {
  return REFUNDABLE.has(failure) && now.getTime() - liveAt.getTime() <= EARLY_DROP_SECONDS * 1000;
}

/**
 * Refund an early drop, inside meterSession's transaction (the session row is locked and still unrefunded, because it
 * was open until this same transaction closed it). The failure code comes from the browser, so it is capped: one refund
 * per session (refunded_at, plus the ledger's unique index) and REFUNDS_PER_DAY per user in any 24 hours, counted under
 * the user's row lock so two sessions ending at once cannot both take the last one. A session that was charged nothing
 * is not counted. Every refund, and every refund the daily limit refused, is written to the audit log.
 */
async function refundEarlyDrop(tx: Tx, userId: string, sessionId: string, i: { now: Date; failure: string; liveMs: number }) {
  await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
  const since = new Date(i.now.getTime() - 86_400_000);
  const [{ n }] = await tx.select({ n: count() }).from(studioSessions)
    .where(and(eq(studioSessions.userId, userId), isNotNull(studioSessions.refundedAt), gte(studioSessions.refundedAt, since)));
  const meta = { sessionId, failure: i.failure, liveSeconds: Math.round(i.liveMs / 100) / 10 };
  if (n >= REFUNDS_PER_DAY) {
    await tx.insert(auditLog).values({ actorId: "system", action: "session.refund_refused", target: userId, meta: { ...meta, why: "daily_limit", limit: REFUNDS_PER_DAY } });
    return 0;
  }
  const r = await refundSessionDebits(tx, userId, sessionId);
  if (r.total <= 0) return 0;
  await tx.update(studioSessions).set({ refundedAt: i.now, refundedCredits: r.total }).where(eq(studioSessions.id, sessionId));
  await tx.insert(auditLog).values({ actorId: "system", action: "session.refund", target: userId, meta: { ...meta, credits: r.total, monthly: r.monthly, purchased: r.purchased } });
  return r.total;
}

/** Reasons that mean "it broke", as opposed to someone choosing to stop. */
const FAILURE_ENDS = new Set(["connection_failed", "stale", "failed_connect"]);
const connectWindowPassed = (startedAt: Date, now: Date) => now.getTime() - startedAt.getTime() >= CONNECT_GRACE_SECONDS * 1000;

/**
 * How a session that never went live is closed (always with 0 credits): `failed_connect` once its connect window has
 * passed or when a failure closes it; otherwise the given reason (the user's Stop, a Reconnect, a newer session).
 * No `end` and the window still open: it stays open.
 */
export function neverLiveEndReason(startedAt: Date, now: Date, end?: string): string | undefined {
  if (end) return FAILURE_ENDS.has(end) || connectWindowPassed(startedAt, now) ? "failed_connect" : end;
  return connectWindowPassed(startedAt, now) ? "failed_connect" : undefined;
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

/**
 * Close sessions whose heartbeat stopped, billed only up to the last heartbeat, and sessions that never went live within
 * CONNECT_GRACE_SECONDS, as failed_connect with nothing billed (even if they are still heartbeating).
 */
export async function sweepStaleSessions(now = new Date()) {
  const cutoff = new Date(now.getTime() - STALE_AFTER_SECONDS * 1000);
  const connectCutoff = new Date(now.getTime() - CONNECT_GRACE_SECONDS * 1000);
  const open = await db().select({ id: studioSessions.id, userId: studioSessions.userId, last: studioSessions.lastHeartbeatAt, liveAt: studioSessions.liveAt })
    .from(studioSessions).where(and(isNull(studioSessions.endedAt), or(
      lt(studioSessions.lastHeartbeatAt, cutoff),
      and(isNull(studioSessions.liveAt), lt(studioSessions.startedAt, connectCutoff)),
    )));
  let closed = 0;
  for (const s of open) {
    if (s.liveAt) { await meterSession(s.id, s.userId, { now: s.last, end: "stale" }); closed++; }
    else if (await closeNeverLive(s.id, now)) closed++;
  }
  return closed;
}

/**
 * Close a session as failed_connect ONLY if it is still open and still has no live time, in one statement: no ledger
 * row is written, and a session that went live a moment ago is left to its normal billing instead of being cut off.
 */
async function closeNeverLive(sessionId: string, now: Date) {
  const r = await db().update(studioSessions).set({ endedAt: now, endReason: "failed_connect" })
    .where(and(eq(studioSessions.id, sessionId), isNull(studioSessions.endedAt), isNull(studioSessions.liveAt))).returning({ id: studioSessions.id });
  return r.length > 0;
}

/**
 * Close the user's open sessions before they start a new one (one live session per user).
 * A session whose heartbeat stopped is closed exactly as the sweep would close it, billed up to its LAST heartbeat,
 * so the bill does not depend on whether the best-effort sweep happened to run first. Billing it up to "now" would
 * charge someone whose computer died for every second until they came back, up to their plan's session length.
 * A session that is still heartbeating is settled up to now and marked superseded. A session that never went live
 * (no transformed frame yet) is closed with nothing billed, whichever of these applies: as failed_connect once its
 * connect window has passed, as superseded while it was still within it (lib/metering.ts neverLiveEndReason).
 */
export async function closeOpenSessions(userId: string, now = new Date()) {
  const cutoff = now.getTime() - STALE_AFTER_SECONDS * 1000;
  const open = await db().select({ id: studioSessions.id, last: studioSessions.lastHeartbeatAt }).from(studioSessions)
    .where(and(eq(studioSessions.userId, userId), isNull(studioSessions.endedAt)));
  for (const s of open) {
    if (s.last.getTime() < cutoff) await meterSession(s.id, userId, { now: s.last, end: "stale" });
    else await meterSession(s.id, userId, { now, end: "superseded" });
  }
  return open.length;
}

export type LiveResult =
  | { status: "live"; liveAt: Date; already: boolean }
  | { status: "not_found" }
  | { status: "ended"; reason: string | null }
  | { status: "too_late" };

/**
 * The browser saw the first transformed frame: record the server time as the session's live time. Only the owner's own
 * open session, and only once: a repeat (a retried request, a second tab) changes nothing and reports the first time.
 * Row-locked, so two concurrent calls cannot both set it. A report that arrives after the connect window has passed
 * is refused and the session is closed as failed_connect, with nothing billed, like every other path does.
 */
export async function markLive(sessionId: string, userId: string, now = new Date()): Promise<LiveResult> {
  return db().transaction(async (tx) => {
    const [row] = await tx.select({ liveAt: studioSessions.liveAt, endedAt: studioSessions.endedAt, endReason: studioSessions.endReason, startedAt: studioSessions.startedAt })
      .from(studioSessions).where(and(eq(studioSessions.id, sessionId), eq(studioSessions.userId, userId))).for("update");
    if (!row) return { status: "not_found" as const };
    if (row.endedAt) return { status: "ended" as const, reason: row.endReason };
    if (row.liveAt) return { status: "live" as const, liveAt: row.liveAt, already: true };
    if (connectWindowPassed(row.startedAt, now)) {
      await tx.update(studioSessions).set({ endedAt: now, endReason: "failed_connect" }).where(eq(studioSessions.id, sessionId));
      return { status: "too_late" as const };
    }
    // Going live is a sign of life too, so it counts as a heartbeat.
    await tx.update(studioSessions).set({ liveAt: now, lastHeartbeatAt: now }).where(eq(studioSessions.id, sessionId));
    return { status: "live" as const, liveAt: now, already: false };
  });
}

/**
 * Whether the fal proxy may mint a connection token for this session: the caller's own, still open, heartbeating (heard
 * from within STALE_AFTER_SECONDS), and either live or still inside its connect window. So a session that never went
 * live gets tokens for CONNECT_GRACE_SECONDS at most, and an abandoned one gets none, even before anything has closed it.
 */
export async function activeSession(sessionId: string, userId: string, now = new Date()) {
  const [s] = await db().select({ startedAt: studioSessions.startedAt, liveAt: studioSessions.liveAt, last: studioSessions.lastHeartbeatAt }).from(studioSessions)
    .where(and(eq(studioSessions.id, sessionId), eq(studioSessions.userId, userId), isNull(studioSessions.endedAt)));
  if (!s) return false;
  if (now.getTime() - s.last.getTime() > STALE_AFTER_SECONDS * 1000) return false;
  return s.liveAt !== null || !connectWindowPassed(s.startedAt, now);
}

/**
 * The never-connected cooldown (NEVER_LIVE_LIMIT in lib/plans.ts): null when the user may start a session, otherwise
 * how many seconds until they may. Counts the user's sessions started in the window that were closed without ever going
 * live, whatever closed them (a failure, a timeout, or the browser's own Stop, which a tampered client could send).
 */
export async function neverLiveCooldown(userId: string, now = new Date()): Promise<number | null> {
  const since = new Date(now.getTime() - NEVER_LIVE_WINDOW_SECONDS * 1000);
  const rows = await db().select({ startedAt: studioSessions.startedAt }).from(studioSessions)
    .where(and(eq(studioSessions.userId, userId), isNull(studioSessions.liveAt), isNotNull(studioSessions.endedAt), gte(studioSessions.startedAt, since)))
    .orderBy(desc(studioSessions.startedAt)).limit(NEVER_LIVE_LIMIT + 1);
  if (rows.length <= NEVER_LIVE_LIMIT) return null;
  // Allowed again once the oldest of these has left the window: then at most NEVER_LIVE_LIMIT remain.
  const until = rows[NEVER_LIVE_LIMIT].startedAt.getTime() + NEVER_LIVE_WINDOW_SECONDS * 1000;
  return Math.max(1, Math.ceil((until - now.getTime()) / 1000));
}
