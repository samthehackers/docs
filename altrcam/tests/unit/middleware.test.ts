/**
 * The real middleware.ts and root layout, with Clerk's middleware factory and provider replaced by recorders, so we can see the
 * options they are given and what the request handler does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReactElement } from "react";

type Handler = (auth: unknown, req: NextRequest) => Promise<Response | void>;
const h = vi.hoisted(() => ({ opts: null as unknown, handler: null as null | ((auth: unknown, req: unknown) => Promise<Response | void>) }));
vi.mock("@clerk/nextjs/server", async (orig) => {
  const real = await orig<typeof import("@clerk/nextjs/server")>();
  return {
    ...real,
    clerkMiddleware: (handler: Handler, opts: unknown) => { h.opts = opts; h.handler = handler as typeof h.handler; return handler; },
  };
});
vi.mock("@clerk/nextjs", () => ({ ClerkProvider: function ClerkProvider() { return null; } }));

import { AUTH_URLS } from "@/lib/routes";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; vi.resetModules(); });
const withClerkKeys = () => { process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x"; process.env.CLERK_SECRET_KEY = "sk_test_x"; };
const withoutClerkKeys = () => { delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; delete process.env.CLERK_SECRET_KEY; };

describe("Clerk's URLs are set in code, not by undocumented env vars", () => {
  it("AUTH_URLS: our own pages, and the dashboard after signing in or up", () => {
    expect(AUTH_URLS).toEqual({ signInUrl: "/sign-in", signUpUrl: "/sign-up", signInFallbackRedirectUrl: "/dashboard", signUpFallbackRedirectUrl: "/dashboard" });
  });
  it("clerkMiddleware is given the sign-in and sign-up URLs", async () => {
    withClerkKeys();
    await import("@/middleware");
    expect(h.opts).toEqual({ signInUrl: "/sign-in", signUpUrl: "/sign-up" });
  });
  it("ClerkProvider gets all four, whatever NEXT_PUBLIC_CLERK_*_URL says", async () => {
    withClerkKeys();
    process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL = "/somewhere-else";
    const { default: RootLayout } = await import("@/app/layout");
    const el = RootLayout({ children: null }) as ReactElement<Record<string, unknown>>;
    expect((el.type as { name?: string }).name).toBe("ClerkProvider");
    expect(el.props).toMatchObject(AUTH_URLS);
  });
  it("without Clerk keys no provider is mounted at all (public pages must render without Clerk)", async () => {
    withoutClerkKeys();
    const { default: RootLayout } = await import("@/app/layout");
    expect((RootLayout({ children: null }) as ReactElement).type).toBe("html");
  });
  it("no NEXT_PUBLIC_CLERK_*_URL variable is read anywhere in our code or documented as needed", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["middleware.ts", "app/layout.tsx", ".env.example"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/NEXT_PUBLIC_CLERK_(SIGN_IN|SIGN_UP)_(URL|FALLBACK_REDIRECT_URL)=/);
    }
  });
});

describe("the middleware's request handling", () => {
  const req = (p: string) => new NextRequest(`http://localhost${p}`);
  /** A stand-in for Clerk's `auth` argument: records protect() calls, signed out. */
  const fakeAuth = () => { const protect = vi.fn(async () => {}); return Object.assign(async () => ({ userId: null }), { protect }); };

  it("with Clerk: an unknown URL is not sent to sign-in (protect is not called), so the 404 page shows", async () => {
    withClerkKeys();
    await import("@/middleware");
    for (const p of ["/nonexistent", "/some/old/link", "/pricing", "/api/health", "/api/webhooks/clerk"]) {
      const auth = fakeAuth();
      await h.handler!(auth, req(p));
      expect(auth.protect, p).not.toHaveBeenCalled();
    }
  });
  it("with Clerk: every protected area still asks for sign-in", async () => {
    withClerkKeys();
    await import("@/middleware");
    for (const p of ["/dashboard", "/studio", "/history/1", "/presets", "/referrals", "/billing/success", "/settings/security", "/support", "/admin", "/api/account"]) {
      const auth = fakeAuth();
      await h.handler!(auth, req(p));
      expect(auth.protect, p).toHaveBeenCalledTimes(1);
    }
  });
  it("without Clerk: protected paths answer 503 with the reason; unknown paths fall through to the 404", async () => {
    withoutClerkKeys();
    const { default: mw } = await import("@/middleware");
    const run = (p: string) => (mw as (r: NextRequest) => Response)(req(p));
    expect(run("/dashboard").status).toBe(503);
    expect(await run("/dashboard").text()).toContain("not configured");
    expect(run("/nonexistent").headers.get("x-middleware-next")).toBe("1");
    expect(run("/pricing").headers.get("x-middleware-next")).toBe("1");
  });
});
