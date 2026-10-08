import { NextResponse } from "next/server";
import { handle, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { markAllRead } from "@/lib/notifications";

export const POST = handle(async () => {
  const userId = await requireUserId();
  await markAllRead(db(), userId);
  return NextResponse.json({ ok: true });
});
