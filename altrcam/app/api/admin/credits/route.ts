import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireAdminId } from "@/lib/api";
import { db } from "@/lib/db";
import { auditLog, users } from "@/db/schema";
import { debitCredits, grantCredits } from "@/lib/credits";
import { notify } from "@/lib/notifications";

const Body = z.object({ userId: z.string().min(1), amount: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000), reason: z.string().trim().min(3).max(200) });

/** Positive = grant (purchased bucket, so it doesn't expire); negative = revoke (monthly first). */
export const POST = handle(async (req: Request) => {
  const adminId = await requireAdminId();
  const b = await parseBody(req, Body);
  const [u] = await db().select({ id: users.id }).from(users).where(eq(users.id, b.userId));
  if (!u) throw new HttpError(404, "User not found");
  await db().transaction(async (tx) => {
    if (b.amount > 0) await grantCredits(tx, b.userId, b.amount, "purchased", "admin_grant", { type: "admin", id: adminId });
    else await debitCredits(tx, b.userId, -b.amount, "admin_revoke", { type: "admin", id: adminId });
    await tx.insert(auditLog).values({ actorId: adminId, action: b.amount > 0 ? "credits.grant" : "credits.revoke", target: b.userId, meta: { amount: b.amount, reason: b.reason } });
  });
  if (b.amount > 0) await notify(db(), b.userId, "credits", "Credits added", `${b.amount} credits were added to your account.`);
  return NextResponse.json({ ok: true });
});
