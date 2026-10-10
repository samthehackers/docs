/**
 * Navigation, rendered to HTML: the marketing header (desktop bar and mobile menu) in every sign-in state, the account menu, the
 * current-page marker, and the signed-in shell's header. Clerk's hooks and the pathname are stubbed; the hooks count their calls so
 * we can see Clerk is never touched for a signed-out visitor (the marketing pages must render with no Clerk configured).
 * The menus' behaviour in a real browser (Escape, focus, skip link) is in tests/public/site.spec.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({
  me: null as string | null, path: "/" as string | null, hookCalls: 0,
  clerkUser: null as null | { imageUrl?: string; fullName?: string | null },
  admin: false, notificationsFail: false, adminFails: false, notificationsError: null as null | Error,
}));
vi.mock("@clerk/nextjs", () => ({
  useUser: () => { h.hookCalls++; return { isLoaded: !!h.clerkUser, user: h.clerkUser ?? undefined }; },
  useClerk: () => { h.hookCalls++; return { signOut: async () => {} }; },
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.me }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), usePathname: () => h.path }));
// The signed-in shell's data sources; the shell itself is what is under test.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/session-user", () => ({
  requireAppUser: async () => ({ id: "user_1", name: "Ada Lovelace", email: "ada@example.com", avatarUrl: "https://img.clerk.com/ada.png", referredBy: null, createdAt: new Date() }),
}));
vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => { if (h.notificationsFail) throw h.notificationsError ?? new Error("db down"); return []; },
  unreadCount: async () => { if (h.notificationsFail) throw new Error("db down"); return 0; },
}));
vi.mock("@/lib/api", () => ({ isAdmin: async () => { if (h.adminFails) throw new Error("clerk api down"); return h.admin; } }));

import MarketingLayout from "@/app/(marketing)/layout";
import AppLayout from "@/app/(app)/layout";
import { AccountMenu } from "@/components/account-menu";
import { NavLinks } from "@/components/nav-links";
import { ACCOUNT_LINKS, APP_LINKS, headerAuth, isCurrent, PAGE_LINKS } from "@/lib/nav";

beforeAll(() => { (globalThis as { React?: unknown }).React = React; });
const ENV = { ...process.env };
const open = () => { process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x"; process.env.CLERK_SECRET_KEY = "sk_test_x"; process.env.DATABASE_URL = "postgres://x"; process.env.SIGNUPS_OPEN = "true"; };
beforeEach(() => { h.me = null; h.path = "/"; h.hookCalls = 0; h.clerkUser = null; h.admin = false; h.notificationsFail = false; h.adminFails = false; h.notificationsError = null; open(); });
afterEach(() => { process.env = { ...ENV }; });

const html = (el: ReactElement) => renderToStaticMarkup(el);
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hrefs = (s: string) => [...s.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
/** The marketing header split into the desktop bar and the mobile menu panel. */
async function header() {
  const s = html((await MarketingLayout({ children: "PAGE" })) as ReactElement);
  const head = s.slice(s.indexOf("<header"), s.indexOf("</header>"));
  const menuAt = head.indexOf('aria-label="Menu"');
  return { all: s, desktop: head.slice(0, menuAt), menu: head.slice(head.indexOf('data-testid="site-menu"')) };
}
/** The <a> tags (opening tag and text) that link to `href`. */
const anchors = (s: string, href: string) => [...s.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].filter((m) => m[1].includes(`href="${href}"`)).map((m) => ({ attrs: m[1], text: plain(m[2]) }));
const texts = (s: string) => [...s.matchAll(/<(?:a|button)\b[^>]*>(.*?)<\/(?:a|button)>/g)].map((m) => plain(m[1])).filter(Boolean);

describe("headerAuth and isCurrent", () => {
  it("picks the header state from sign-in, sign-up and the session", () => {
    expect(headerAuth({ signedIn: true, accountsOpen: false, signInOpen: false })).toBe("signed-in");
    expect(headerAuth({ signedIn: false, accountsOpen: true, signInOpen: true })).toBe("open");
    expect(headerAuth({ signedIn: false, accountsOpen: false, signInOpen: true })).toBe("sign-in-only");
    expect(headerAuth({ signedIn: false, accountsOpen: false, signInOpen: false })).toBe("closed");
  });
  it("marks a page and the pages under it, not look-alikes", () => {
    expect(isCurrent("/billing", "/billing")).toBe(true);
    expect(isCurrent("/billing/success", "/billing")).toBe(true);
    expect(isCurrent("/billingx", "/billing")).toBe(false);
    expect(isCurrent("/", "/billing")).toBe(false);
    expect(isCurrent(null, "/billing")).toBe(false);
  });
});

describe("the marketing header", () => {
  it("signed out, accounts open: Sign in (ghost) and Get started free (primary), in the bar and in the menu", async () => {
    const { desktop, menu } = await header();
    const [signIn] = anchors(desktop, "/sign-in"), [getStarted] = anchors(desktop, "/sign-up");
    expect(signIn.text).toBe("Sign in");
    expect(signIn.attrs).toMatch(/hover:bg-muted/); // the ghost button
    expect(signIn.attrs).not.toMatch(/bg-gradient/);
    expect(getStarted.text).toBe("Get started free");
    expect(getStarted.attrs).toMatch(/bg-gradient-to-r/); // the primary button
    expect(texts(menu)).toEqual([...PAGE_LINKS.map((l) => l.label), "Sign in", "Get started free"]);
    expect(hrefs(menu)).toEqual([...PAGE_LINKS.map((l) => l.href), "/sign-in", "/sign-up"]);
    expect(h.hookCalls).toBe(0);
  });
  it("signed out, nothing configured: today's closed header, no sign-in or sign-up anywhere, and Clerk is never touched", async () => {
    for (const k of ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "DATABASE_URL", "SIGNUPS_OPEN"]) delete process.env[k];
    const { desktop, menu } = await header();
    for (const part of [desktop, menu]) {
      expect(hrefs(part)).not.toContain("/sign-in");
      expect(hrefs(part)).not.toContain("/sign-up");
      expect(plain(part)).not.toMatch(/Sign in|Get started|Sign out|Dashboard/);
    }
    expect(texts(menu)).toEqual(PAGE_LINKS.map((l) => l.label));
    expect(h.hookCalls).toBe(0);
  });
  it("sign-up switched off but sign-in configured: only Sign in, so existing accounts can still get in", async () => {
    delete process.env.SIGNUPS_OPEN;
    const { desktop, menu } = await header();
    for (const part of [desktop, menu]) { expect(hrefs(part)).toContain("/sign-in"); expect(hrefs(part)).not.toContain("/sign-up"); }
  });
  it("signed in: Dashboard and the account menu (Dashboard, Studio, Billing, Settings, Sign out); the menu has the same", async () => {
    h.me = "user_1";
    const { desktop, menu } = await header();
    expect(anchors(desktop, "/dashboard")[0].text).toBe("Dashboard");
    expect(desktop).toContain('aria-label="Account menu"');
    const account = desktop.slice(desktop.indexOf('data-testid="account-menu"'));
    expect(texts(account)).toEqual(["Dashboard", "Studio", "Billing", "Settings", "Sign out"]);
    expect(texts(menu)).toEqual([...PAGE_LINKS.map((l) => l.label), "Dashboard", "Studio", "Billing", "Settings", "Sign out"]);
    for (const part of [desktop, menu]) expect(plain(part)).not.toMatch(/Sign in|Get started/);
  });
  it("the mobile menu button says what it controls and starts closed; the desktop bar is hidden below md, the button from md", async () => {
    const { all } = await header();
    const button = all.match(/<button[^>]*aria-label="Menu"[^>]*>/)![0];
    expect(button).toContain('aria-expanded="false"');
    const controls = button.match(/aria-controls="([^"]+)"/)![1];
    expect(all).toMatch(new RegExp(`<div[^>]*id="${controls.replace(/[:]/g, "\\\\:")}"[^>]*hidden=""`));
    expect(all).toMatch(/<div class="hidden items-center gap-2 text-sm md:flex">/);
    expect(all).toMatch(/<div class="md:hidden">/);
  });
  it("a skip link comes first and targets <main id=\"content\">", async () => {
    const { all } = await header();
    expect(all.indexOf('href="#content"')).toBeLessThan(all.indexOf("<header"));
    expect(all).toMatch(/<a href="#content"[^>]*>Skip to content<\/a>/);
    expect(all).toContain('<main id="content"');
  });
  it("marks the page being shown in the bar and the menu", async () => {
    h.path = "/pricing";
    const { desktop, menu } = await header();
    for (const part of [desktop, menu]) {
      expect(anchors(part, "/pricing")[0].attrs).toContain('aria-current="page"');
      expect((part.match(/aria-current="page"/g) ?? []).length).toBe(1);
    }
  });
});

describe("the account menu", () => {
  const menu = (p: Parameters<typeof AccountMenu>[0] = {}) => html(React.createElement(AccountMenu, p));
  it("lists the four account pages then Sign out, closed until opened", () => {
    const s = menu();
    expect(texts(s.slice(s.indexOf('data-testid="account-menu"')))).toEqual([...ACCOUNT_LINKS.map((l) => l.label), "Sign out"]);
    expect(s).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-label="Account menu"|<button[^>]*aria-label="Account menu"[^>]*aria-expanded="false"/);
    expect(s).toMatch(/data-testid="account-menu"[^>]*hidden=""|hidden=""[^>]*data-testid="account-menu"/);
  });
  it("shows Clerk's picture once Clerk has loaded, else the one the server passed, else an icon", () => {
    h.clerkUser = { imageUrl: "https://img.clerk.com/live.png", fullName: "Ada L." };
    expect(menu({ avatarUrl: "https://img.clerk.com/db.png" })).toContain('src="https://img.clerk.com/live.png"');
    h.clerkUser = null;
    expect(menu({ avatarUrl: "https://img.clerk.com/db.png", name: "Ada Lovelace" })).toContain('src="https://img.clerk.com/db.png"');
    const none = menu();
    expect(none).not.toContain("<img");
    expect(none).toContain("<svg");
  });
  it("names who is signed in", () => {
    expect(plain(menu({ name: "Ada Lovelace", email: "ada@example.com" }))).toContain("Ada Lovelace");
    expect(plain(menu({ email: "ada@example.com" }))).toContain("ada@example.com");
  });
});

describe("NavLinks", () => {
  it("puts aria-current=page on the current page only, including pages under it", () => {
    h.path = "/billing/success";
    const s = html(React.createElement(NavLinks, { links: APP_LINKS, className: "x", activeClass: "on" }));
    expect(s.match(/aria-current="page"/g)).toHaveLength(1);
    expect(anchors(s, "/billing")[0].attrs).toContain('aria-current="page"');
    expect(anchors(s, "/billing")[0].attrs).toContain('class="x on"');
  });
  it("marks nothing on a page outside the list", () => {
    h.path = "/";
    expect(html(React.createElement(NavLinks, { links: APP_LINKS }))).not.toContain("aria-current");
  });
});

describe("the signed-in shell's header", () => {
  const shell = async () => html((await AppLayout({ children: "PAGE" })) as ReactElement);
  it("has every app page in the bar and the narrow-screen row, the current one marked, and the account menu", async () => {
    h.path = "/history";
    const s = await shell();
    for (const l of APP_LINKS) expect(s.split(`href="${l.href}"`).length - 1, l.href).toBeGreaterThanOrEqual(2);
    expect(anchors(s, "/history").map((a) => a.attrs.includes('aria-current="page"'))).toEqual([true, true]);
    expect((s.match(/aria-current="page"/g) ?? []).length).toBe(2); // bar + row; the account menu has no History
    expect(s).toContain('aria-label="Account menu"');
    expect(s).toContain('src="https://img.clerk.com/ada.png"'); // the users row's avatar until Clerk loads
    expect(plain(s)).toContain("Ada Lovelace");
    expect(s).not.toContain('href="/admin"');
    expect(s).toContain('<main id="content"');
  });
  it("shows Admin to admins", async () => {
    h.admin = true;
    expect(await shell()).toContain('href="/admin"');
  });
  it("only shows the inline nav from lg (1024px), and the bell and account menu can't be squeezed off-screen", async () => {
    const s = await shell();
    expect(s).toMatch(/<nav aria-label="Main" class="hidden min-w-0 items-center gap-0.5 text-sm lg:flex">/);
    expect(s).toMatch(/<nav aria-label="Main" class="flex gap-1 overflow-x-auto border-t px-2 py-1 text-sm lg:hidden">/);
    expect(s).toMatch(/<div class="flex shrink-0 items-center gap-2">/);
    expect(s).not.toMatch(/\bmd:flex\b|\bmd:hidden\b/);
  });
  it("uses our account menu, not Clerk's UserButton, so both headers offer the same items", () => {
    for (const f of ["app/(app)/layout.tsx", "components/app-header.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/UserButton/);
  });
});

describe("the signed-in shell when the header's extras fail", () => {
  const shell = async () => html((await AppLayout({ children: "PAGE_BODY" })) as ReactElement);
  it("normally has the notification bell", async () => {
    expect(await shell()).toMatch(/aria-label="Notifications/);
  });
  it("a failing notification query: no bell, the rest of the header and the page still render, and it is logged", async () => {
    h.notificationsFail = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await shell();
    expect(s).not.toMatch(/aria-label="Notifications/);
    expect(s).toContain("PAGE_BODY");
    expect(s).toContain('aria-label="Account menu"');
    expect(err).toHaveBeenCalledWith(expect.stringContaining("notifications failed"), "db down");
    err.mockRestore();
  });
  it("a failing admin check (Clerk's API): no Admin link, nothing else lost", async () => {
    h.admin = true; h.adminFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await shell();
    expect(s).not.toContain('href="/admin"');
    expect(s).toMatch(/aria-label="Notifications/);
    expect(s).toContain("PAGE_BODY");
    err.mockRestore();
  });
  it("both failing at once still renders the page", async () => {
    h.notificationsFail = true; h.adminFails = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await shell()).toContain("PAGE_BODY");
    err.mockRestore();
  });
  it("Next's own signals are not swallowed (a redirect thrown while loading still redirects)", async () => {
    h.notificationsFail = true;
    h.notificationsError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
    await expect(AppLayout({ children: null })).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
});

describe("error and 404 pages", () => {
  it("app/error.tsx and app/global-error.tsx: branded, a Retry button that calls reset, a link to /contact, and the reference", async () => {
    const { default: RootError } = await import("@/app/error");
    const { default: GlobalError } = await import("@/app/global-error");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const C of [RootError, GlobalError]) {
      const s = html(React.createElement(C, { error: Object.assign(new Error("boom"), { digest: "d1g3st" }), reset: () => {} }));
      expect(s).toContain('aria-label="AltrCam home"');
      expect(s).toMatch(/<button[^>]*>Retry<\/button>/);
      expect(hrefs(s)).toEqual(expect.arrayContaining(["/contact", "/"]));
      expect(plain(s)).toContain("Reference: d1g3st");
      expect(plain(s)).not.toContain("boom"); // the message itself is not shown to visitors
    }
    expect(html(React.createElement(GlobalError, { error: new Error("x"), reset: () => {} }))).toMatch(/^<html lang="en"/);
    err.mockRestore();
  });
  it("the 404 has a title and links to Pricing, How it works and Contact", async () => {
    const mod = await import("@/app/not-found");
    expect(mod.metadata).toEqual({ title: "Page not found" });
    const s = html(React.createElement(mod.default));
    expect(plain(s)).toContain("That page doesn't exist.");
    expect(hrefs(s)).toEqual(["/", "/pricing", "/how-it-works", "/contact"]);
  });
});
