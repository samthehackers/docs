import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { studioSessions } from "@/db/schema";
import { getUserRow } from "@/lib/users";
import { ledgerBalance } from "@/lib/credits";
import { PLANS } from "@/lib/plans";
import { meterSession } from "@/lib/metering";

const Body = z.object({ presetId: z.number().int().optional(), settings: z.record(z.unknown()).optional() });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("sessionStart", userId);
  const body = await parseBody(req, Body);
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  const bal = await ledgerBalance(db(), userId);
  if (bal.total <= 0) throw new HttpError(402, "Out of credits", { code: "no_credits" });

  // One live session per user: settle and close any earlier one first.
  const open = await db().select({ id: studioSessions.id }).from(studioSessions).where(and(eq(studioSessions.userId, userId), isNull(studioSessions.endedAt)));
  for (const s of open) await meterSession(s.id, userId, { end: "superseded" });

  const plan = PLANS[user.plan];
  const id = randomUUID();
  await db().insert(studioSessions).values({ id, userId, maxSeconds: plan.maxSessionSeconds, presetId: body.presetId, settings: body.settings ?? null });
  return NextResponse.json({ sessionId: id, maxSeconds: plan.maxSessionSeconds, resolution: plan.maxResolution, clipRecording: plan.clipRecording, remaining: bal.total });
});
