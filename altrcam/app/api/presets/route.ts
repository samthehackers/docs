import { NextResponse } from "next/server";
import { count, desc, eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { presets } from "@/db/schema";
import { getUserRow } from "@/lib/users";
import { PLANS } from "@/lib/plans";
import { assertOwnPath } from "@/lib/storage";
import { PresetBody } from "@/lib/schemas";

export const GET = handle(async () => {
  const userId = await requireUserId();
  const rows = await db().select().from(presets).where(eq(presets.userId, userId)).orderBy(desc(presets.createdAt));
  return NextResponse.json({ presets: rows });
});

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  const b = await parseBody(req, PresetBody);
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  if (b.imagePath) assertOwnPath(userId, b.imagePath);
  const [{ n }] = await db().select({ n: count() }).from(presets).where(eq(presets.userId, userId));
  const cap = PLANS[user.plan].presets;
  if (n >= cap) throw new HttpError(403, `Your plan allows ${cap} presets`, { code: "preset_cap" });
  const [row] = await db().insert(presets).values({ userId, name: b.name, kind: b.kind, prompt: b.prompt, imagePath: b.imagePath ?? null, settings: b.settings ?? null }).returning();
  return NextResponse.json({ preset: row }, { status: 201 });
});
