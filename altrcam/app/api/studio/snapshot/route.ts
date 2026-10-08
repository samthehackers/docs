import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { handle, parseBody, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { studioSessions, transformations } from "@/db/schema";
import { assertOwnPath } from "@/lib/storage";

const Body = z.object({
  thumbnailPath: z.string().max(300),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().max(1000).default(""),
  type: z.enum(["face", "background", "outfit", "style", "custom"]).default("custom"),
  sessionId: z.string().uuid().optional(),
  settings: z.record(z.unknown()).optional(),
});

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  const b = await parseBody(req, Body);
  assertOwnPath(userId, b.thumbnailPath);
  let sessionId: string | null = null;
  if (b.sessionId) {
    const [s] = await db().select({ id: studioSessions.id }).from(studioSessions).where(and(eq(studioSessions.id, b.sessionId), eq(studioSessions.userId, userId)));
    sessionId = s?.id ?? null;
  }
  const [row] = await db().insert(transformations).values({ userId, sessionId, title: b.title, prompt: b.prompt, type: b.type, settings: b.settings ?? null, thumbnailUrl: b.thumbnailPath }).returning({ id: transformations.id });
  return NextResponse.json({ id: row.id });
});
