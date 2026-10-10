import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { deleteAccount, getUserRow } from "@/lib/users";

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
  await deleteAccount(userId, { deleteAuthUser: true });
  return NextResponse.json({ ok: true });
});
