import { NextResponse, type NextRequest } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/lib/config";

import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/lib/routes";

const isPublic = createRouteMatcher(PUBLIC_ROUTES);
const isProtected = createRouteMatcher(PROTECTED_ROUTES);

const withClerk = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
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
