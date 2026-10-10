import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfigured } from "@/lib/config";

/**
 * Sign out with a plain form POST, so it works before the page's JavaScript has loaded and clears the session cookies on
 * the server (and revokes the refresh token with Supabase). Only same-origin form posts are accepted.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  // A cross-site request is refused outright. A missing Origin is accepted only when the browser says the request is
  // same-origin/none (or sends no Fetch Metadata at all, e.g. older clients).
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (origin && origin !== url.origin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!origin && site && site !== "same-origin" && site !== "none") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (supabaseConfigured()) {
    try { await (await createClient()).auth.signOut(); }
    catch (e) { console.error("[auth/sign-out]", e instanceof Error ? e.message : e); }
  }
  return NextResponse.redirect(new URL("/", url.origin), { status: 303 });
}
