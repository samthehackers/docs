import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { deleteAccount, getUserRow, SubscriptionCancelError } from "@/lib/users";

export const PATCH = handle(async (req: Request) => {
  const userId = await requireUserId();
  const b = await parseBody(req, z.object({ notifyEmail: z.boolean() }));
  await db().update(users).set({ notifyEmail: b.notifyEmail }).where(eq(users.id, userId));
  return NextResponse.json({ ok: true });
});

export const DELETE = handle(async (req: Request) => {
  const userId = await requireUserId();
  const b = await parseBody(req, z.object({ confirm: z.string() }));
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(404, "Not found");
  if (b.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm");
  try {
    await deleteAccount(userId, { deleteClerk: true, onCancelFailure: "abort" });
  } catch (e) {
    if (e instanceof SubscriptionCancelError) {
      throw new HttpError(502, "We couldn't cancel your Pro subscription with the payment provider, so your account was not deleted (deleting it now could leave you being charged). Nothing was changed. Please try again in a few minutes or contact support.", { code: "cancel_failed" });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
});
