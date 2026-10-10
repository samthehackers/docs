import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isProtectedPath, isPublicPath } from "@/lib/routes";

// Through NextRequest so paths are normalised exactly as middleware sees them (e.g. `/faq/../admin` → `/admin`).
const path = (p: string) => new NextRequest(`http://localhost${p}`).nextUrl.pathname;
const isPublic = (p: string) => isPublicPath(path(p));
const isProtected = (p: string) => isProtectedPath(path(p));

describe("route access rules", () => {
  it.each(["/", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact", "/robots.txt", "/sitemap.xml",
    "/sign-in", "/sign-in/factor-one", "/sign-up", "/sign-up/verify", "/api/webhooks/paystack", "/api/health", "/api/cron/refill"])(
    "%s is public", (p) => { expect(isPublic(p)).toBe(true); expect(isProtected(p)).toBe(false); });

  it.each(["/dashboard", "/studio", "/history", "/presets", "/referrals", "/billing", "/billing/success", "/settings", "/settings/password",
    "/support", "/admin", "/admin?tab=users"])("%s requires sign-in and is not public", (p) => {
    expect(isPublic(p)).toBe(false);
    expect(isProtected(p)).toBe(true);
  });

  it.each(["/api/studio/session/start", "/api/studio/session/heartbeat", "/api/fal/proxy", "/api/payments/checkout", "/api/admin/credits",
    "/api/admin/plan", "/api/presets", "/api/history/1", "/api/account", "/api/support", "/api/notifications"])("%s is a protected API", (p) => {
    expect(isPublic(p)).toBe(false);
    expect(isProtected(p)).toBe(true);
  });

  it("does not let look-alike paths slip into the public set", () => {
    for (const p of ["/pricing-secret", "/faq/../admin", "/api/healthz", "/api/webhooksx/foo", "/sign-inn", "/sign-in-anything", "/sign-up2", "/dashboard/pricing", "/pricing/x", "/api/health/x"]) {
      expect(isPublic(p)).toBe(false);
    }
  });

  it("`/` is the home page only, not a prefix that makes everything public", () => {
    expect(isPublic("/dashboard")).toBe(false);
    expect(isProtected("/dashboard")).toBe(true);
  });

  it("auth landing pages are reachable signed out (they create the session)", () => {
    for (const p of ["/auth/callback", "/auth/confirm", "/verify-email"]) expect(isProtected(p)).toBe(false);
  });

  it("leaves unknown pages to the normal 404", () => {
    expect(isPublic("/nonexistent")).toBe(false);
    expect(isProtected("/nonexistent")).toBe(false);
  });
});
