import { NextResponse, type NextRequest } from "next/server";
import { REFERRAL } from "@/lib/plans";
import { makeRefCookie, parseRefCookie } from "@/lib/referral-cookie";
import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/lib/routes";
import { updateSession } from "@/lib/supabase/proxy";

const publicPath = (pathname: string) => PUBLIC_ROUTES.some((route) => new RegExp(route.replace("(.*)", ".*")).test(pathname));
const protectedPath = (pathname: string) => PROTECTED_ROUTES.some((route) => new RegExp(route.replace("(.*)", ".*")).test(pathname));
export default async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);
  if (!publicPath(request.nextUrl.pathname) && protectedPath(request.nextUrl.pathname) && !user) return NextResponse.redirect(new URL("/sign-in", request.url));
  const ref = request.nextUrl.searchParams.get("ref");
  if (ref && REFERRAL.codePattern.test(ref) && !parseRefCookie(request.cookies.get(REFERRAL.cookie)?.value) && !user) {
    const value = makeRefCookie(ref);
    if (value) response.cookies.set(REFERRAL.cookie, value, { maxAge: REFERRAL.cookieDays * 86400, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  }
  return response;
}
export const config = { matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"] };
