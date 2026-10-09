/**
 * Route access rules, shared by both middleware variants and unit-tested. Clerk matcher syntax.
 * Public entries use an exact path or a `/` boundary: a bare `(.*)` suffix (e.g. `/sign-in(.*)`) would also make
 * `/sign-inn` or `/sign-in-anything` public, so a future route with such a name would silently skip auth.
 */
export const PUBLIC_ROUTES = [
  "/", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact",
  "/robots.txt", "/sitemap.xml", "/sign-in", "/sign-in/(.*)", "/sign-up", "/sign-up/(.*)", "/api/webhooks/(.*)", "/api/health",
  // Cron routes authenticate with CRON_SECRET inside the handler.
  "/api/cron/(.*)",
];

/** Everything that needs a signed-in user. Used to answer 503 (not 404/crash) when Clerk isn't configured. */
export const PROTECTED_ROUTES = [
  "/dashboard(.*)", "/studio(.*)", "/history(.*)", "/presets(.*)", "/referrals(.*)",
  "/billing(.*)", "/settings(.*)", "/support(.*)", "/admin(.*)", "/api/(.*)",
];

/**
 * Where Clerk sends people, hard-coded so nothing depends on the NEXT_PUBLIC_CLERK_*_URL variables (set here, they win over those).
 * ClerkProvider (app/layout.tsx) takes all four; clerkMiddleware (middleware.ts) takes the two page URLs. After signing in or
 * signing up, people land on the dashboard unless they were on their way somewhere (Clerk's redirect_url).
 */
export const AUTH_URLS = {
  signInUrl: "/sign-in",
  signUpUrl: "/sign-up",
  signInFallbackRedirectUrl: "/dashboard",
  signUpFallbackRedirectUrl: "/dashboard",
} as const;
