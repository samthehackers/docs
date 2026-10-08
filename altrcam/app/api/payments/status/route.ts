import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { handle, HttpError, parseQuery, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { payments } from "@/db/schema";

// Read-only: the success page only polls. Access is granted by the verified webhook, never here.
export const GET = handle(async (req: Request) => {
  const userId = await requireUserId();
  const { ref } = parseQuery(req.url, z.object({ ref: z.string().min(5).max(100) }));
  const [p] = await db().select({ status: payments.status }).from(payments).where(and(eq(payments.reference, ref), eq(payments.userId, userId)));
  if (!p) throw new HttpError(404, "Not found");
  return NextResponse.json({ status: p.status });
});
