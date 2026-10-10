/**
 * Route access rules, used by middleware.ts and unit-tested. `(.*)` means "anything after this prefix".
 * Public entries use an exact path or a `/` boundary: a bare `(.*)` suffix (e.g. `/sign-in(.*)`) would also make
 * `/sign-inn` or `/sign-in-anything` public, so a future route with such a name would silently skip auth.
 */
export const PUBLIC_ROUTES = [
  "/", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact",
  "/robots.txt", "/sitemap.xml", "/sign-in", "/sign-in/(.*)", "/sign-up", "/sign-up/(.*)", "/api/webhooks/(.*)", "/api/health",
  // Cron routes authenticate with CRON_SECRET inside the handler.
  "/api/cron/(.*)",
];

/** Everything that needs a signed-in user: middleware sends signed-out visitors to /sign-in (pages) or answers 401 (APIs). */
export const PROTECTED_ROUTES = [
  "/dashboard(.*)", "/studio(.*)", "/history(.*)", "/presets(.*)", "/referrals(.*)",
  "/billing(.*)", "/settings(.*)", "/support(.*)", "/admin(.*)", "/api/(.*)",
];

/** Whole-path match: `(.*)` is "anything after this prefix", everything else is literal. Anchored, so `/` is only `/`. */
const toRegExp = (route: string) => new RegExp(`^${route.split("(.*)").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const PUBLIC_RE = PUBLIC_ROUTES.map(toRegExp);
const PROTECTED_RE = PROTECTED_ROUTES.map(toRegExp);
export const isPublicPath = (pathname: string) => PUBLIC_RE.some((r) => r.test(pathname));
/** Needs a signed-in user: on the protected list and not on the public one (webhooks, health and cron stay public). */
export const isProtectedPath = (pathname: string) => !isPublicPath(pathname) && PROTECTED_RE.some((r) => r.test(pathname));
