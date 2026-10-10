import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { studioSessions } from "@/db/schema";
import { getUserRow } from "@/lib/users";
import { ledgerBalance } from "@/lib/credits";
import { getPlan } from "@/lib/plan-config";
import { closeOpenSessions, neverLiveCooldown } from "@/lib/metering";
import { capabilities } from "@/lib/config";

const Body = z.object({ presetId: z.number().int().optional(), settings: z.record(z.unknown()).optional() });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  if (!capabilities().liveTransformation) throw new HttpError(503, "Live transformation isn't available yet. The service is not configured.", { code: "unavailable" });
  await rateLimit("sessionStart", userId);
  const body = await parseBody(req, Body);
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  const bal = await ledgerBalance(db(), userId);
  if (bal.total <= 0) throw new HttpError(402, "Out of credits", { code: "no_credits" });
  // A session that never shows video costs nothing, so repeated attempts that never go live are paused for a while.
  const wait = await neverLiveCooldown(userId);
  if (wait !== null) {
    const minutes = Math.ceil(wait / 60);
    throw new HttpError(429, `Your last few attempts didn't connect, so going live is paused for about ${minutes} minute${minutes === 1 ? "" : "s"}. Nothing was charged for them. A VPN, firewall or restrictive network is a common cause: try another network when you go live again.`, { code: "connect_cooldown", retryAfterSeconds: wait });
  }

  // One live session per user: settle and close any earlier one first (a silent one is billed only to its last heartbeat).
  await closeOpenSessions(userId);

  const plan = await getPlan(user.plan);
  const id = randomUUID();
  await db().insert(studioSessions).values({ id, userId, maxSeconds: plan.maxSessionSeconds, presetId: body.presetId, settings: body.settings ?? null });
  return NextResponse.json({ sessionId: id, maxSeconds: plan.maxSessionSeconds, resolution: plan.maxResolution, clipRecording: plan.clipRecording, remaining: bal.total });
});
