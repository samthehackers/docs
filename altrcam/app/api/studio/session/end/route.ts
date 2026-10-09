import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { meterSession } from "@/lib/metering";
import { CLIENT_END_REASONS } from "@/lib/session-end";

// `reason` says why the browser ended the session (Admin shows it). Optional so older clients and the pagehide beacon keep working.
const Body = z.object({ sessionId: z.string().uuid(), reason: z.enum(CLIENT_END_REASONS).optional() });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  const { sessionId, reason } = await parseBody(req, Body);
  const m = await meterSession(sessionId, userId, { end: reason ?? "user" });
  if (!m) throw new HttpError(404, "Session not found");
  return NextResponse.json({ remaining: m.remaining, secondsBilled: m.secondsBilled });
});
