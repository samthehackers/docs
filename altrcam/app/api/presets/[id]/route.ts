import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { presets } from "@/db/schema";
import { assertOwnPath } from "@/lib/storage";
import { PresetBody } from "@/lib/schemas";

const idOf = (p: { id: string }) => {
  const n = Number(p.id);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
  return n;
};

export const PATCH = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const userId = await requireUserId();
  const id = idOf(await ctx.params);
  const b = await parseBody(req, PresetBody.partial());
  if (b.imagePath) assertOwnPath(userId, b.imagePath);
  const [row] = await db().update(presets).set({ ...b, imagePath: b.imagePath === undefined ? undefined : b.imagePath }).where(and(eq(presets.id, id), eq(presets.userId, userId))).returning();
  if (!row) throw new HttpError(404, "Not found");
  return NextResponse.json({ preset: row });
});

export const DELETE = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const userId = await requireUserId();
  const id = idOf(await ctx.params);
  const rows = await db().delete(presets).where(and(eq(presets.id, id), eq(presets.userId, userId))).returning({ id: presets.id });
  if (!rows.length) throw new HttpError(404, "Not found");
  return NextResponse.json({ ok: true });
});
