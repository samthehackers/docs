import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createRouteMatcher } from "@clerk/nextjs/server";
import { PROTECTED_ROUTES, PUBLIC_ROUTES } from "@/lib/routes";

const isPublic = createRouteMatcher(PUBLIC_ROUTES);
const isProtected = createRouteMatcher(PROTECTED_ROUTES);
const req = (path: string) => new NextRequest(`http://localhost${path}`);

describe("route access rules", () => {
  it.each(["/", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact", "/robots.txt", "/sitemap.xml",
    "/sign-in", "/sign-in/factor-one", "/sign-up", "/sign-up/verify", "/api/webhooks/paystack", "/api/webhooks/clerk", "/api/health", "/api/cron/refill"])(
    "%s is public", (p) => expect(isPublic(req(p))).toBe(true));

  it.each(["/dashboard", "/studio", "/history", "/presets", "/referrals", "/billing", "/billing/success", "/settings", "/settings/security",
    "/support", "/admin", "/admin?tab=users"])("%s requires sign-in and is not public", (p) => {
    expect(isPublic(req(p))).toBe(false);
    expect(isProtected(req(p))).toBe(true);
  });

  it.each(["/api/studio/session/start", "/api/studio/session/heartbeat", "/api/studio/session/live", "/api/studio/session/end", "/api/account/consent", "/api/fal/proxy", "/api/payments/checkout", "/api/admin/credits",
    "/api/admin/plan", "/api/presets", "/api/history/1", "/api/account", "/api/support", "/api/notifications"])("%s is a protected API", (p) => {
    expect(isPublic(req(p))).toBe(false);
    expect(isProtected(req(p))).toBe(true);
  });

  it("does not let look-alike paths slip into the public set", () => {
    for (const p of ["/pricing-secret", "/faq/../admin", "/api/healthz", "/api/webhooksx/foo", "/sign-inn", "/sign-in-anything", "/sign-up2", "/dashboard/pricing", "/pricing/x", "/api/health/x"]) {
      expect(isPublic(req(p))).toBe(false);
    }
  });

  it("leaves unknown pages to the normal 404", () => {
    expect(isPublic(req("/nonexistent"))).toBe(false);
    expect(isProtected(req("/nonexistent"))).toBe(false);
  });
});
