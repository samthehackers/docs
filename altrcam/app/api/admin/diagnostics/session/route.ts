import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { startDiagnosticsSession } from "@/lib/admin-diagnostics";

/** Admin only: an unbilled session for the realtime check (/admin/diagnostics). See lib/admin-diagnostics.ts. */
export const POST = handle(async (req: Request) => NextResponse.json(await startDiagnosticsSession(req)));
