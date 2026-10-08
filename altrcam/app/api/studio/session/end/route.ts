import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { meterSession } from "@/lib/metering";

const Body = z.object({ sessionId: z.string().uuid() });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  const { sessionId } = await parseBody(req, Body);
  const m = await meterSession(sessionId, userId, { end: "user" });
  if (!m) throw new HttpError(404, "Session not found");
  return NextResponse.json({ remaining: m.remaining, secondsBilled: m.secondsBilled });
});
