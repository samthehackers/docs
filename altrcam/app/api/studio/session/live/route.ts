import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { markLive } from "@/lib/metering";

const Body = z.object({ sessionId: z.string().uuid() });

/**
 * The Studio calls this when the FIRST transformed frame renders. The server records its own clock as the session's
 * live time, once; credits are counted only from then. Idempotent, and only for the caller's own open session.
 */
export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("live", userId);
  const { sessionId } = await parseBody(req, Body);
  const r = await markLive(sessionId, userId);
  if (r.status === "not_found") throw new HttpError(404, "Session not found");
  if (r.status === "ended") throw new HttpError(409, "This session has already ended", { code: "ended", reason: r.reason });
  return NextResponse.json({ liveAt: r.liveAt.toISOString(), alreadyLive: r.already });
});
