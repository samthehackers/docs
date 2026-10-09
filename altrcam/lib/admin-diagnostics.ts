/**
 * Server side of the admin realtime check (/admin/diagnostics). Same rule as lib/admin.ts: every exported function
 * checks that the caller is an admin ITSELF, first. The page's data function uses the page gate (redirect); the two
 * session functions back /api/admin/diagnostics/session[/end] and use the API gate (401/403).
 *
 * THE DIAGNOSTICS SESSION. The fal token proxy (/api/fal/proxy) only mints a token for an OPEN studio_sessions row that
 * belongs to the signed-in user. The check gets such a row from here rather than from the Studio's start route, so:
 *  - Only admins can create one (Clerk role, checked on every call). A non-admin gets 403 and no row, so this is not a
 *    way to get fal tokens without credits; a non-admin cannot use an admin's row either (the proxy checks the owner).
 *  - It bills nothing, by construction: max_seconds is 0, and the metering math caps billable seconds at max_seconds
 *    (lib/credits-math.ts computeMeter), so whatever meters it (end, heartbeat, the stale sweep, the next Studio start)
 *    debits 0 credits. It is ended here without metering.
 *  - It leaves the admin's own Studio session alone (no closeOpenSessions), and keeps at most one diagnostics row open
 *    per admin: starting a new check closes an earlier one that was left open (tab closed mid-check).
 *  - It is labelled: settings.diagnostics = true, end_reason "diagnostics", and an audit-log row at start and at end
 *    (who ran it and the result), because each check uses real, paid fal time.
 *  - It is rate-limited with the session-start limit's settings, under its own key.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditLog, studioSessions } from "@/db/schema";
import { db } from "@/lib/db";
import { HttpError, parseBody, requireAdminId } from "@/lib/api";
import { capabilities } from "@/lib/config";
import { FAL_APP, FAL_APP_ALIAS } from "@/lib/fal/config";
import { rateLimit } from "@/lib/ratelimit";
import { requireAdminPage } from "@/lib/session-user";
import { getUserRow } from "@/lib/users";

/** studio_sessions.end_reason for a closed diagnostics row. */
export const DIAGNOSTICS_END_REASON = "diagnostics";
/** Billable seconds of a diagnostics row: none. See the header comment. */
export const DIAGNOSTICS_MAX_SECONDS = 0;

const isDiagnosticsRow = sql`(${studioSessions.settings} ->> 'diagnostics') = 'true'`;

/** For /admin/diagnostics: whether the service is configured, what the check connects to, and the last recorded runs. */
export async function diagnosticsOverview() {
  await requireAdminPage();
  const recent = await db().select().from(auditLog)
    .where(inArray(auditLog.action, ["diagnostics.end"]))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(10);
  return { configured: capabilities().liveTransformation, app: FAL_APP, tokenApp: FAL_APP_ALIAS, recent };
}

const StartBody = z.object({ prompt: z.string().trim().max(500).optional() });

/** POST /api/admin/diagnostics/session: a short, unbilled session the token proxy accepts, for this admin only. */
export async function startDiagnosticsSession(req: Request) {
  const adminId = await requireAdminId();
  if (!capabilities().liveTransformation) throw new HttpError(503, "Live transformation isn't configured on this deployment (FAL_KEY is not set).", { code: "unavailable" });
  await rateLimit("sessionStart", `diagnostics:${adminId}`);
  const body = await parseBody(req, StartBody);
  if (!(await getUserRow(adminId))) throw new HttpError(403, "Account not found");

  const d = db();
  const id = randomUUID();
  const now = new Date();
  await d.transaction(async (tx) => {
    // At most one open diagnostics row per admin. Closing it bills nothing (no metering, and max_seconds is 0 anyway).
    await tx.update(studioSessions).set({ endedAt: now, endReason: DIAGNOSTICS_END_REASON })
      .where(and(eq(studioSessions.userId, adminId), isNull(studioSessions.endedAt), isDiagnosticsRow));
    await tx.insert(studioSessions).values({
      id, userId: adminId, maxSeconds: DIAGNOSTICS_MAX_SECONDS,
      settings: { diagnostics: true, prompt: `[diagnostics] ${body.prompt ?? ""}`.trim() },
    });
    await tx.insert(auditLog).values({ actorId: adminId, action: "diagnostics.start", target: id, meta: { app: FAL_APP } });
  });
  return { sessionId: id, app: FAL_APP, maxSeconds: DIAGNOSTICS_MAX_SECONDS };
}

const EndBody = z.object({
  sessionId: z.string().uuid(),
  result: z.object({
    pass: z.boolean(),
    failureCode: z.string().max(40).nullable(),
    timeToFirstFrameMs: z.number().finite().nullable(),
    fps: z.number().finite().nullable(),
    rttMs: z.number().finite().nullable(),
  }).partial().optional(),
});

/** POST /api/admin/diagnostics/session/end: close this admin's diagnostics row without billing, and record the result. */
export async function endDiagnosticsSession(req: Request) {
  const adminId = await requireAdminId();
  const body = await parseBody(req, EndBody);
  const d = db();
  // Only a diagnostics row of this admin: this cannot be used to close a normal Studio session unbilled.
  const mine = and(eq(studioSessions.id, body.sessionId), eq(studioSessions.userId, adminId), isDiagnosticsRow);
  const closed = await d.update(studioSessions).set({ endedAt: new Date(), endReason: DIAGNOSTICS_END_REASON })
    .where(and(mine, isNull(studioSessions.endedAt))).returning({ id: studioSessions.id });
  if (!closed.length) {
    const [row] = await d.select({ id: studioSessions.id }).from(studioSessions).where(mine);
    if (!row) throw new HttpError(404, "Diagnostics session not found");
  }
  // Record the result. The row may already be closed (by the page's pagehide beacon, which sends no result, or by the
  // stale sweep, since a diagnostics row never heartbeats); the result is still worth keeping.
  if (closed.length || body.result) {
    await d.insert(auditLog).values({ actorId: adminId, action: "diagnostics.end", target: body.sessionId, meta: { ...(body.result ?? {}) } });
  }
  return { ended: true, alreadyEnded: !closed.length };
}
