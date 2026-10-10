import { NextResponse, type NextRequest } from "next/server";
import { REFERRAL } from "@/lib/plans";
import { makeRefCookie, parseRefCookie } from "@/lib/referral-cookie";
import { isProtectedPath } from "@/lib/routes";
import { updateSession } from "@/lib/supabase/proxy";
import { databaseUrl } from "@/lib/database-url";

const authConfigured = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()));

/** Answer for the signed-in app when the deployment can't run it, instead of a crash deep inside a page. */
function unavailable(pathname: string, what: string) {
  const message = `Accounts are not available on this deployment: ${what} is not configured.`;
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: message, code: "unavailable" }, { status: 503 });
  return new NextResponse(message, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = isProtectedPath(pathname);

  // Without Supabase Auth (or the database) nothing signed-in can work: say so (503), and leave public pages alone.
  if (!authConfigured()) return isProtected ? unavailable(pathname, "sign-in") : NextResponse.next();
  if (isProtected && !databaseUrl()) return unavailable(pathname, "the database");

  let response: NextResponse, user: { id: string } | null;
  try {
    ({ response, user } = await updateSession(request));
  } catch (e) {
    // Supabase Auth unreachable: public pages still render signed out; protected ones send the visitor to sign in.
    console.error("[middleware] session refresh failed:", e instanceof Error ? e.message : e);
    response = NextResponse.next({ request }); user = null;
  }
  if (isProtected && !user) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  const ref = request.nextUrl.searchParams.get("ref");
  if (ref && REFERRAL.codePattern.test(ref) && !parseRefCookie(request.cookies.get(REFERRAL.cookie)?.value) && !user) {
    const value = makeRefCookie(ref);
    if (value) response.cookies.set(REFERRAL.cookie, value, { maxAge: REFERRAL.cookieDays * 86400, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  return response;
}
export const config = { matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"] };
