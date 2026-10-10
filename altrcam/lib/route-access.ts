import type { NextRequest } from "next/server";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/lib/routes";

const isPublic = createRouteMatcher(PUBLIC_ROUTES);
const isProtected = createRouteMatcher(PROTECTED_ROUTES);

/**
 * Whether a request needs a signed-in user: it is on a protected path (PROTECTED_ROUTES lists every app, admin and API path)
 * and not on an explicitly public one (webhooks, health and cron live under /api). Everything else, including URLs that don't
 * exist, passes through, so a signed-out visitor on a bad link gets the branded 404 instead of a sign-in page. Both middleware
 * variants use this one rule (with Clerk: auth.protect(); without: 503).
 */
export const requiresSignIn = (req: NextRequest) => isProtected(req) && !isPublic(req);
