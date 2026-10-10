import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createRouteHandler } from "@fal-ai/server-proxy/nextjs";
import { activeSession } from "@/lib/metering";
import { FAL_APP_ALIASES } from "@/lib/fal/config";

export const runtime = "nodejs";

// The fal realtime client mints a short-lived token via POST rest.fal.ai/tokens/.
// That is the only thing this proxy forwards, and only for the Lucy realtime app. Audited in tests/unit/fal-proxy.test.ts.
/** Compared as an exact string: no http://, other port, query, fragment or credentials. */
const TOKEN_URL = "https://rest.fal.ai/tokens/";
const MAX_TOKEN_SECONDS = 300;

const inner = createRouteHandler({
  allowedUrlPatterns: ["rest.fal.ai/tokens/"],
  allowedEndpoints: ["tokens"], // belt and braces; allowedUrlPatterns is the real gate
  allowUnauthorizedRequests: false,
  isAuthenticated: async () => true, // authenticated + authorised below, before delegating
  // Always our key. The library's default forwards the CALLER's Authorization header instead when there is one (it can be
  // their Clerk session token), and sends "Key undefined" when FAL_KEY is unset.
  resolveFalAuth: async () => `Key ${process.env.FAL_KEY}`,
});

const deny = (status: number, msg: string) => Response.json({ error: msg }, { status, headers: { "cache-control": "no-store" } });

async function guard(req: NextRequest): Promise<Response | { app: string; seconds: number }> {
  const { userId } = await auth();
  if (!userId) return deny(401, "Unauthorized");
  if (req.method !== "POST") return deny(405, "Method not allowed");

  const sessionId = req.headers.get("x-altrcam-session");
  if (!sessionId || !(await activeSession(sessionId, userId))) return deny(403, "No active studio session");
  if (!process.env.FAL_KEY) return deny(503, "Live transformation is not configured");

  if (req.headers.get("x-fal-target-url") !== TOKEN_URL) return deny(400, "Invalid request");

  const body = (await req.clone().json().catch(() => null)) as { allowed_apps?: unknown; token_expiration?: unknown } | null;
  const apps = body?.allowed_apps;
  if (!Array.isArray(apps) || apps.length !== 1 || typeof apps[0] !== "string" || !FAL_APP_ALIASES.includes(apps[0])) return deny(400, "App not allowed");
  const seconds = body?.token_expiration;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1) return deny(400, "Invalid token lifetime");
  if (seconds > MAX_TOKEN_SECONDS) return deny(400, "Token lifetime too long");
  return { app: apps[0], seconds };
}

export async function POST(req: NextRequest) {
  const ok = await guard(req);
  if (ok instanceof Response) return ok;
  // Forward a rebuilt request: the fixed target and the checked fields only, none of the caller's other headers or fields.
  const ua = req.headers.get("user-agent");
  const clean = new NextRequest(req.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fal-target-url": TOKEN_URL, ...(ua ? { "user-agent": ua } : {}) },
    body: JSON.stringify({ allowed_apps: [ok.app], token_expiration: ok.seconds }),
  });
  let upstream: Response, text: string;
  try {
    upstream = await inner.POST(clean);
    text = await upstream.text(); // inside the try: a body that breaks off is the same failure as no answer
  } catch {
    console.error("[fal-proxy] the token request to fal failed"); // no error text: it could carry request details
    return deny(502, "The token service could not be reached");
  }
  // Our own response: fal's status and body, none of its headers (no cookies on our domain), never cached.
  const key = process.env.FAL_KEY ?? "";
  if (key && text.includes(key)) {
    console.error("[fal-proxy] fal's response contained the API key; withheld");
    return deny(502, "Invalid response from the token service");
  }
  return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
}
export const GET = async () => deny(405, "Method not allowed");
export const PUT = async () => deny(405, "Method not allowed");
