import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createRouteHandler } from "@fal-ai/server-proxy/nextjs";
import { activeSession } from "@/lib/metering";
import { FAL_APP_ALIASES } from "@/lib/fal/config";

export const runtime = "nodejs";

// The fal realtime client mints a short-lived token via POST rest.fal.ai/tokens/.
// That is the only thing this proxy forwards, and only for the Lucy realtime app.
const inner = createRouteHandler({
  allowedUrlPatterns: ["rest.fal.ai/tokens/"],
  allowedEndpoints: ["tokens"], // belt and braces; allowedUrlPatterns is the real gate
  allowUnauthorizedRequests: false,
  isAuthenticated: async () => true, // authenticated + authorised below, before delegating
});

const deny = (status: number, msg: string) => Response.json({ error: msg }, { status });

async function guard(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return deny(401, "Unauthorized");
  if (req.method !== "POST") return deny(405, "Method not allowed");

  const sessionId = req.headers.get("x-altrcam-session");
  if (!sessionId || !(await activeSession(sessionId, userId))) return deny(403, "No active studio session");

  const target = req.headers.get("x-fal-target-url");
  let url: URL;
  try { url = new URL(target ?? ""); } catch { return deny(400, "Invalid request"); }
  if (url.hostname !== "rest.fal.ai" || url.pathname !== "/tokens/") return deny(400, "Invalid request");

  const body = (await req.clone().json().catch(() => null)) as { allowed_apps?: unknown; token_expiration?: unknown } | null;
  const apps = body?.allowed_apps;
  if (!Array.isArray(apps) || apps.length !== 1 || !FAL_APP_ALIASES.includes(String(apps[0]))) return deny(400, "App not allowed");
  if (typeof body?.token_expiration === "number" && body.token_expiration > 300) return deny(400, "Token lifetime too long");
  return null;
}

export async function POST(req: NextRequest) {
  return (await guard(req)) ?? inner.POST(req);
}
export const GET = async () => deny(405, "Method not allowed");
export const PUT = async () => deny(405, "Method not allowed");
