import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { meterSession } from "@/lib/metering";

const Body = z.object({
  sessionId: z.string().uuid(),
  stats: z.object({ fps: z.number().min(0).max(240).optional(), rttMs: z.number().min(0).max(60000).optional() }).optional(),
});

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("heartbeat", userId);
  const { sessionId, stats } = await parseBody(req, Body);
  const m = await meterSession(sessionId, userId, { stats });
  if (!m) throw new HttpError(404, "Session not found");
  return NextResponse.json({ remaining: m.remaining, continue: m.continue, reason: m.reason, secondsLeftInSession: m.secondsLeftInSession });
});
