import { NextResponse } from "next/server";
import { handle, requireCron } from "@/lib/api";
import { sweepStaleSessions } from "@/lib/metering";

export const runtime = "nodejs";

export const GET = handle(async (req: Request) => {
  requireCron(req);
  return NextResponse.json({ closed: await sweepStaleSessions() });
});
