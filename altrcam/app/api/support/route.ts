import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { supportTickets } from "@/db/schema";

const Body = z.object({ subject: z.string().trim().min(3).max(140), body: z.string().trim().min(10).max(4000) });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("ticket", userId);
  const b = await parseBody(req, Body);
  const [t] = await db().insert(supportTickets).values({ userId, subject: b.subject, body: b.body }).returning({ id: supportTickets.id });
  return NextResponse.json({ id: t.id }, { status: 201 });
});
