import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/lib/config";
import { REFERRAL } from "@/lib/plans";

import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/lib/routes";

const isPublic = createRouteMatcher(PUBLIC_ROUTES);
const isProtected = createRouteMatcher(PROTECTED_ROUTES);

const withClerk = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();

  // Referral links look like /?ref=<code>. Remember the code (last click wins) until the visitor signs up.
  const ref = req.nextUrl.searchParams.get("ref");
  if (ref && REFERRAL.codePattern.test(ref)) {
    const res = NextResponse.next();
    res.cookies.set(REFERRAL.cookie, ref, {
      maxAge: REFERRAL.cookieDays * 86_400, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/",
    });
    return res;
  }
});

// Without Clerk keys, public pages still serve and protected ones say why they are unavailable.
// Anything else falls through so unknown URLs get the normal branded 404.
function withoutClerk(req: NextRequest) {
  if (!isPublic(req) && isProtected(req)) return new NextResponse("Sign-in is not configured on this deployment yet.", { status: 503 });
  return NextResponse.next();
}

export default clerkConfigured() ? withClerk : withoutClerk;

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
