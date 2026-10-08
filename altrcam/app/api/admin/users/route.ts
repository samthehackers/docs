import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, parseQuery, requireAdminId } from "@/lib/api";
import { searchUsers } from "@/lib/admin";

export const GET = handle(async (req: Request) => {
  await requireAdminId();
  const { q } = parseQuery(req.url, z.object({ q: z.string().max(100).default("") }));
  return NextResponse.json({ users: await searchUsers(q) });
});
