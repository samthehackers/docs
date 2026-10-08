import { NextResponse } from "next/server";
import { capabilities } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Liveness plus which integrations are configured. Booleans only: no values, no connectivity probes. */
export function GET() {
  return NextResponse.json({ status: "ok", capabilities: capabilities() }, { headers: { "Cache-Control": "no-store" } });
}
