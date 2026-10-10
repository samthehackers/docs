import { NextResponse } from "next/server";
import { and, eq, lt, inArray } from "drizzle-orm";
import { handle, requireCron } from "@/lib/api";
import { db } from "@/lib/db";
import { payments, transformations, users } from "@/db/schema";
import { getPlans } from "@/lib/plan-config";
import { deletePaths } from "@/lib/storage";
import { downgradeExpired } from "@/lib/payments/fulfil";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Daily: purge history beyond each plan's retention, downgrade lapsed paid plans, and close checkouts nobody finished. */
export const GET = handle(async (req: Request) => {
  requireCron(req);
  let purged = 0;
  const plans = await getPlans();
  for (const plan of ["FREE", "PRO"] as const) {
    const days = plans[plan].historyDays;
    if (!days) continue;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const owners = db().select({ id: users.id }).from(users).where(eq(users.plan, plan));
    const rows = await db().delete(transformations).where(and(lt(transformations.createdAt, cutoff), inArray(transformations.userId, owners))).returning();
    await deletePaths(rows.flatMap((r) => [r.thumbnailUrl, r.exportUrl]).filter((p): p is string => !!p));
    purged += rows.length;
  }
  const downgraded = await downgradeExpired();
  // A checkout still pending after a day was never paid (the providers confirm within minutes). It is only a label: if a payment
  // for it does arrive later, fulfilment still applies it (it upgrades any status except success).
  const abandoned = (await db().update(payments).set({ status: "abandoned" })
    .where(and(eq(payments.status, "pending"), lt(payments.createdAt, new Date(Date.now() - 86_400_000)))).returning({ id: payments.id })).length;
  return NextResponse.json({ purged, downgraded, abandoned });
});
