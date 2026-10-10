import { NextResponse } from "next/server";
import { handle } from "@/lib/api";
import { endDiagnosticsSession } from "@/lib/admin-diagnostics";

/** Admin only: close a diagnostics session (never billed) and record the check's result. See lib/admin-diagnostics.ts. */
export const POST = handle(async (req: Request) => NextResponse.json(await endDiagnosticsSession(req)));
