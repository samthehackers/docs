import { NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { handle, requireCron } from "@/lib/api";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { refillApplied, resetMonthly } from "@/lib/credits";
import { PLANS } from "@/lib/plans";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Monthly refill: unused monthly credits expire, purchased top-ups are untouched. Idempotent per period. */
export const GET = handle(async (req: Request) => {
  requireCron(req);
  const period = new Date().toISOString().slice(0, 7);
  const all = await db().select({ id: users.id, plan: users.plan }).from(users).where(isNull(users.deletedAt));
  let refilled = 0;
  for (const u of all) {
    if (await refillApplied(db(), u.id, period)) continue;
    await db().transaction((tx) => resetMonthly(tx, u.id, PLANS[u.plan].monthlyCredits, period));
    refilled++;
  }
  return NextResponse.json({ period, refilled });
});
