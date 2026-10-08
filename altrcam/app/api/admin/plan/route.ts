import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireAdminId } from "@/lib/api";
import { db } from "@/lib/db";
import { auditLog, users } from "@/db/schema";
import { notify } from "@/lib/notifications";

const Body = z.object({ userId: z.string().min(1), plan: z.enum(["FREE", "PRO", "LIFETIME"]) });

export const POST = handle(async (req: Request) => {
  const adminId = await requireAdminId();
  const b = await parseBody(req, Body);
  const renews = b.plan === "PRO" ? new Date(Date.now() + 31 * 86_400_000) : null;
  const rows = await db().update(users).set({ plan: b.plan, planStatus: "active", planRenewsAt: renews }).where(eq(users.id, b.userId)).returning({ id: users.id });
  if (!rows.length) throw new HttpError(404, "User not found");
  await db().insert(auditLog).values({ actorId: adminId, action: "plan.change", target: b.userId, meta: { plan: b.plan } });
  await notify(db(), b.userId, "plan_change", "Plan updated", `Your plan is now ${b.plan}.`);
  return NextResponse.json({ ok: true });
});
