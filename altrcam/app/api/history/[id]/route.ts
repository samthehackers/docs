import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { handle, HttpError, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { transformations } from "@/db/schema";
import { deletePaths } from "@/lib/storage";

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const userId = await requireUserId();
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "Bad id");
  const [row] = await db().delete(transformations).where(and(eq(transformations.id, id), eq(transformations.userId, userId))).returning();
  if (!row) throw new HttpError(404, "Not found");
  await deletePaths([row.thumbnailUrl, row.exportUrl].filter((p): p is string => !!p && p.startsWith(`${userId}/`)));
  return NextResponse.json({ ok: true });
});
