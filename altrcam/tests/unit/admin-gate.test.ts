/**
 * The /admin page and its data. The layout redirects non-admins, but a layout is not a security boundary: Next.js renders a
 * layout and its page in parallel, so the page and every query behind it must check the role themselves. These tests call
 * the page function and each admin data function directly (no layout involved) as a signed-out visitor, as an ordinary
 * signed-in user and as an admin, with real sensitive rows in the database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import * as React from "react";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null, admins: new Set<string>() }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.me }),
  currentUser: async () => null,
  clerkClient: async () => ({ users: { getUser: async (id: string) => ({ publicMetadata: { role: h.admins.has(id) ? "admin" : "user" } }) } }),
  clerkMiddleware: () => () => {}, createRouteMatcher: () => () => false,
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, payments, studioSessions, supportTickets, users, webhookEvents } from "@/db/schema";
import { adminAudit, adminPayments, adminPlans, adminSessions, adminTickets, adminWebhooks, kpis, searchUsers, userDetail } from "@/lib/admin";
import Admin from "@/app/(admin)/admin/page";

let d: DB;
beforeAll(async () => {
  (globalThis as { React?: unknown }).React = React; // the page is JSX; Next compiles it with the automatic runtime, Vitest here does not
  d = await testDb(); h.db = d;
}, 60_000);
beforeEach(async () => {
  process.env.PRICE_CURRENCY = "NGN";
  h.me = null; h.admins = new Set(["boss"]);
  await d.execute(sql`truncate users, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, support_tickets restart identity cascade`);
  await d.insert(users).values([{ id: "boss", email: "boss@x.co", name: "Boss" }, { id: "plain", email: "plain@x.co", name: "Plain" }, { id: "victim", email: "victim-private@x.co", name: "Victim" }]);
  await d.insert(payments).values({ userId: "victim", provider: "paystack", reference: "REF-PRIVATE", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "success" });
  await d.insert(supportTickets).values({ userId: "victim", subject: "Private subject", body: "SECRET-TICKET-BODY" });
  await d.insert(auditLog).values({ actorId: "boss", action: "credits.grant", target: "victim" });
  await d.insert(webhookEvents).values({ provider: "paystack", eventId: "evt-private", type: "charge.success" });
  await d.insert(studioSessions).values({ id: "00000000-0000-4000-8000-000000000001", userId: "victim", maxSeconds: 120 });
});

const props = (tab?: string) => ({ searchParams: Promise.resolve({ tab }) });
const redirectsTo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as { digest?: string }).digest ?? e); }
  return "did not throw";
};

const DATA = {
  "kpis": () => kpis(),
  "searchUsers": () => searchUsers(""),
  "userDetail": () => userDetail("victim"),
  "adminPayments": () => adminPayments(),
  "adminSessions": () => adminSessions(),
  "adminTickets": () => adminTickets(),
  "adminWebhooks": () => adminWebhooks(),
  "adminAudit": () => adminAudit(),
  "adminPlans": () => adminPlans(),
} as const;

describe("a signed-in user who is not an admin", () => {
  beforeEach(() => { h.me = "plain"; });
  it("cannot get the /admin page, for any tab", async () => {
    for (const tab of [undefined, "users", "payments", "tickets", "audit", "webhooks", "sessions", "plans"]) {
      expect(await redirectsTo(Admin(props(tab))), String(tab)).toMatch(/NEXT_REDIRECT.*\/dashboard/);
    }
  });
  for (const [name, call] of Object.entries(DATA)) {
    it(`cannot read ${name} even when it is called directly, without the layout`, async () => {
      expect(await redirectsTo(call())).toMatch(/NEXT_REDIRECT.*\/dashboard/);
    });
  }
});

describe("a visitor who is signed out", () => {
  beforeEach(() => { h.me = null; });
  it("is sent to sign in by the page and by every data function", async () => {
    expect(await redirectsTo(Admin(props("payments")))).toMatch(/NEXT_REDIRECT.*\/sign-in/);
    for (const [name, call] of Object.entries(DATA)) expect(await redirectsTo(call()), name).toMatch(/NEXT_REDIRECT.*\/sign-in/);
  });
});

describe("an admin", () => {
  beforeEach(() => { h.me = "boss"; });
  it("gets the page and the data", async () => {
    for (const tab of [undefined, "users", "payments", "tickets", "audit", "webhooks", "sessions", "plans"]) {
      expect(await Admin(props(tab)), String(tab)).toBeTruthy();
    }
    expect((await adminPayments()).map((p) => p.reference)).toEqual(["REF-PRIVATE"]);
    expect((await adminTickets())[0].body).toBe("SECRET-TICKET-BODY");
    expect((await adminAudit())[0].action).toBe("credits.grant");
    expect((await adminWebhooks())[0].eventId).toBe("evt-private");
    expect(await adminSessions()).toHaveLength(1);
    expect((await searchUsers("victim")).map((u) => u.id)).toEqual(["victim"]);
    expect((await userDetail("victim"))?.payments).toHaveLength(1);
    expect((await kpis()).totalUsers).toBe(3);
    expect((await adminPlans()).plans.FREE.monthlyCredits).toBeGreaterThan(0);
  });
});

describe("the admin page itself", () => {
  it("runs no database queries of its own, so every read goes through a function that checks the role", () => {
    const src = readFileSync(path.resolve("app/(admin)/admin/page.tsx"), "utf8");
    expect(src).not.toMatch(/\.from\(|\.select\(|\.insert\(|\.update\(|\.delete\(/);
  });
});
