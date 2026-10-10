import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { meterSession } from "@/lib/metering";
import { CLIENT_END_REASONS, CLIENT_FAILURE_CODES } from "@/lib/session-end";

// `reason` says why the browser ended the session (Admin shows it). Optional so older clients and the pagehide beacon keep working.
// `failure` is the connection's failure code, used only with reason connection_failed: stored, and an early drop for a
// connection or AI-service failure is refunded (lib/metering.ts, capped per session and per day).
const Body = z.object({
  sessionId: z.string().uuid(),
  reason: z.enum(CLIENT_END_REASONS).optional(),
  failure: z.enum(CLIENT_FAILURE_CODES).optional(),
});

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  const { sessionId, reason, failure } = await parseBody(req, Body);
  const m = await meterSession(sessionId, userId, { end: reason ?? "user", failure });
  if (!m) throw new HttpError(404, "Session not found");
  return NextResponse.json({ remaining: m.remaining, secondsBilled: m.secondsBilled, refunded: m.refunded });
});
