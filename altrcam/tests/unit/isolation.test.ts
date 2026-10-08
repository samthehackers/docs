/**
 * Account isolation + authorization: the real route handlers, run against a real in-memory Postgres,
 * with Clerk's auth mocked to act as a chosen user. The point is that user A can never read, change,
 * delete, bill or cancel anything that belongs to user B, and that admin routes are admin-only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null, admins: new Set<string>() }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.me }),
  clerkClient: async () => ({ users: { getUser: async (id: string) => ({ publicMetadata: { role: h.admins.has(id) ? "admin" : "user" } }), deleteUser: async () => {} } }),
  clerkMiddleware: () => () => {}, createRouteMatcher: () => () => false, currentUser: async () => null,
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));
vi.mock("@/lib/storage", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage")>()), // keep the real assertOwnPath
  deletePaths: vi.fn(async () => {}),
  signedReadUrl: vi.fn(async (p: string) => `https://signed.example/${p}`),
  createSignedUpload: vi.fn(async (u: string, kind: string) => ({ path: `${u}/${kind}/x.jpg`, token: "t", signedUrl: "https://upload.example" })),
  deleteUserFiles: vi.fn(async () => {}),
}));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, payments, presets, studioSessions, subscriptions, supportTickets, transformations, users, notifications, auditLog } from "@/db/schema";
import { ledgerBalance, grantCredits } from "@/lib/credits";
import * as presetsRoute from "@/app/api/presets/route";
import * as presetRoute from "@/app/api/presets/[id]/route";
import * as historyRoute from "@/app/api/history/[id]/route";
import * as heartbeat from "@/app/api/studio/session/heartbeat/route";
import * as endSession from "@/app/api/studio/session/end/route";
import * as statusRoute from "@/app/api/payments/status/route";
import * as cancelRoute from "@/app/api/payments/cancel/route";
import * as uploadRoute from "@/app/api/studio/upload/route";
import * as snapshotRoute from "@/app/api/studio/snapshot/route";
import * as notifRoute from "@/app/api/notifications/route";
import * as accountRoute from "@/app/api/account/route";
import * as adminCredits from "@/app/api/admin/credits/route";
import * as adminPlan from "@/app/api/admin/plan/route";
import * as adminTickets from "@/app/api/admin/tickets/route";
import * as adminUsers from "@/app/api/admin/users/route";
import { dashboardData } from "@/lib/queries";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

const SESSION_B = "11111111-1111-4111-8111-111111111111";
let presetB: number, historyB: number;

beforeEach(async () => {
  process.env.PRICE_CURRENCY = "NGN";
  h.me = null; h.admins = new Set();
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, transformations, presets, support_tickets restart identity cascade`);
  await d.insert(users).values([{ id: "A", email: "a@x.co", name: "A" }, { id: "B", email: "b@x.co", name: "B" }, { id: "ADMIN", email: "admin@x.co", name: "Admin" }]);
  await grantCredits(d, "A", 100, "monthly", "seed");
  await grantCredits(d, "B", 100, "monthly", "seed");
  [{ id: presetB }] = await d.insert(presets).values({ userId: "B", name: "B's preset", kind: "prompt", prompt: "secret" }).returning({ id: presets.id });
  [{ id: historyB }] = await d.insert(transformations).values({ userId: "B", title: "B's clip", thumbnailUrl: "B/thumbnail/t.jpg" }).returning({ id: transformations.id });
  await d.insert(studioSessions).values({ id: SESSION_B, userId: "B", maxSeconds: 120, startedAt: new Date(Date.now() - 30_000) });
  await d.insert(payments).values({ userId: "B", provider: "paystack", reference: "ref_B", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "success" });
  await d.insert(subscriptions).values({ userId: "B", provider: "paystack", providerSubId: "SUB_B", plan: "PRO", status: "active" });
});

const json = (body: unknown, method = "POST") => new Request("http://x/api", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const as = (u: string | null) => { h.me = u; };
type H = (...a: never[]) => Promise<Response>;
const call = (fn: unknown, ...a: unknown[]) => (fn as (...x: unknown[]) => Promise<Response>)(...a);

describe("unauthenticated requests are refused (401) everywhere", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["GET presets", () => call(presetsRoute.GET)],
    ["POST presets", () => call(presetsRoute.POST, json({ name: "x", kind: "prompt" }))],
    ["PATCH preset", () => call(presetRoute.PATCH, json({ name: "x" }, "PATCH"), ctx(presetB))],
    ["DELETE preset", () => call(presetRoute.DELETE, json({}, "DELETE"), ctx(presetB))],
    ["DELETE history", () => call(historyRoute.DELETE, json({}, "DELETE"), ctx(historyB))],
    ["heartbeat", () => call(heartbeat.POST, json({ sessionId: SESSION_B }))],
    ["end session", () => call(endSession.POST, json({ sessionId: SESSION_B }))],
    ["payment status", () => call(statusRoute.GET, new Request("http://x/api?ref=ref_B"))],
    ["cancel subscription", () => call(cancelRoute.POST)],
    ["upload", () => call(uploadRoute.POST, json({ action: "read", path: "B/x.jpg" }))],
    ["snapshot", () => call(snapshotRoute.POST, json({ thumbnailPath: "B/thumbnail/t.jpg", title: "t" }))],
    ["notifications", () => call(notifRoute.POST)],
    ["account patch", () => call(accountRoute.PATCH, json({ notifyEmail: false }, "PATCH"))],
    ["admin credits", () => call(adminCredits.POST, json({ userId: "B", amount: 5, reason: "test" }))],
    ["admin plan", () => call(adminPlan.POST, json({ userId: "B", plan: "PRO" }))],
    ["admin tickets", () => call(adminTickets.POST, json({ id: 1, reply: "hi" }))],
    ["admin users", () => call(adminUsers.GET, new Request("http://x/api/admin/users"))],
  ];
  it.each(cases)("%s", async (_n, run) => { as(null); expect((await run()).status).toBe(401); });
});

describe("user A cannot touch user B's data", () => {
  beforeEach(() => as("A"));

  it("cannot delete B's preset (404) and it survives", async () => {
    expect((await call(presetRoute.DELETE, json({}, "DELETE"), ctx(presetB))).status).toBe(404);
    expect((await d.select().from(presets).where(eq(presets.id, presetB))).length).toBe(1);
  });
  it("cannot edit B's preset (404) and it is unchanged", async () => {
    expect((await call(presetRoute.PATCH, json({ name: "hijacked", prompt: "pwned" }, "PATCH"), ctx(presetB))).status).toBe(404);
    expect((await d.select().from(presets).where(eq(presets.id, presetB)))[0]).toMatchObject({ name: "B's preset", prompt: "secret" });
  });
  it("only ever lists their own presets", async () => {
    const mine = await d.insert(presets).values({ userId: "A", name: "mine", kind: "prompt" }).returning({ id: presets.id });
    const res = await call(presetsRoute.GET);
    const body = await res.json();
    expect(body.presets.map((p: { id: number }) => p.id)).toEqual([mine[0].id]);
  });
  it("cannot delete B's history item", async () => {
    expect((await call(historyRoute.DELETE, json({}, "DELETE"), ctx(historyB))).status).toBe(404);
    expect((await d.select().from(transformations).where(eq(transformations.id, historyB))).length).toBe(1);
  });
  it("cannot heartbeat B's session: 404, and B is not billed", async () => {
    expect((await call(heartbeat.POST, json({ sessionId: SESSION_B }))).status).toBe(404);
    expect((await ledgerBalance(d, "B")).total).toBe(100);
    expect((await d.select().from(studioSessions).where(eq(studioSessions.id, SESSION_B)))[0]).toMatchObject({ secondsBilled: 0, endedAt: null });
  });
  it("cannot end B's session", async () => {
    expect((await call(endSession.POST, json({ sessionId: SESSION_B }))).status).toBe(404);
    expect((await d.select().from(studioSessions).where(eq(studioSessions.id, SESSION_B)))[0].endedAt).toBeNull();
  });
  it("cannot read B's payment status", async () => {
    expect((await call(statusRoute.GET, new Request("http://x/api?ref=ref_B"))).status).toBe(404);
  });
  it("cannot cancel B's subscription", async () => {
    expect((await call(cancelRoute.POST)).status).toBe(404); // A has none
    expect((await d.select().from(subscriptions).where(eq(subscriptions.userId, "B")))[0].status).toBe("active");
  });
  it("cannot get a signed URL for a file under B's prefix", async () => {
    expect((await call(uploadRoute.POST, json({ action: "read", path: "B/reference/secret.jpg" }))).status).toBe(403);
    expect((await call(uploadRoute.POST, json({ action: "read", path: "A/../B/reference/secret.jpg" }))).status).toBe(403);
    expect((await call(uploadRoute.POST, json({ action: "read", path: "A/reference/mine.jpg" }))).status).toBe(200);
  });
  it("cannot attach B's file to their own snapshot or preset", async () => {
    expect((await call(snapshotRoute.POST, json({ thumbnailPath: "B/thumbnail/t.jpg", title: "stolen" }))).status).toBe(403);
    expect((await call(presetsRoute.POST, json({ name: "x", kind: "prompt", imagePath: "B/reference/secret.jpg" }))).status).toBe(403);
  });
  it("cannot link a snapshot to B's session", async () => {
    const r = await call(snapshotRoute.POST, json({ thumbnailPath: "A/thumbnail/t.jpg", title: "mine", sessionId: SESSION_B }));
    expect(r.status).toBe(200);
    const [row] = await d.select().from(transformations).where(eq(transformations.id, (await r.json()).id));
    expect(row.sessionId).toBeNull();
  });
  it("mark-all-read and account settings only affect A", async () => {
    await d.insert(notifications).values([{ userId: "A", type: "t", title: "a" }, { userId: "B", type: "t", title: "b" }]);
    await call(notifRoute.POST);
    const rows = await d.select().from(notifications);
    expect(rows.find((n) => n.userId === "A")!.readAt).not.toBeNull();
    expect(rows.find((n) => n.userId === "B")!.readAt).toBeNull();
    await call(accountRoute.PATCH, json({ notifyEmail: false }, "PATCH"));
    expect((await d.select().from(users).where(eq(users.id, "A")))[0].notifyEmail).toBe(false);
    expect((await d.select().from(users).where(eq(users.id, "B")))[0].notifyEmail).toBe(true);
  });
  it("dashboard data is scoped to the signed-in user", async () => {
    await d.insert(transformations).values({ userId: "A", title: "mine" });
    const data = await dashboardData("A", "FREE");
    expect(data.recent.map((t) => t.title)).toEqual(["mine"]);
    expect(data.balance.total).toBe(100);
  });
  it("a user can heartbeat their own session (control)", async () => {
    await d.insert(studioSessions).values({ id: "22222222-2222-4222-8222-222222222222", userId: "A", maxSeconds: 120, startedAt: new Date(Date.now() - 20_000) });
    const r = await call(heartbeat.POST, json({ sessionId: "22222222-2222-4222-8222-222222222222" }));
    expect(r.status).toBe(200);
    expect((await ledgerBalance(d, "A")).total).toBeLessThan(100);
    expect((await ledgerBalance(d, "B")).total).toBe(100);
  });
});

describe("admin routes are admin-only, enforced on the server", () => {
  it("a normal user gets 403 and nothing changes", async () => {
    as("A");
    expect((await call(adminCredits.POST, json({ userId: "A", amount: 999999, reason: "give myself credits" }))).status).toBe(403);
    expect((await call(adminPlan.POST, json({ userId: "A", plan: "LIFETIME" }))).status).toBe(403);
    expect((await call(adminUsers.GET, new Request("http://x/api/admin/users"))).status).toBe(403);
    const [t] = await d.insert(supportTickets).values({ userId: "B", subject: "s", body: "b" }).returning();
    expect((await call(adminTickets.POST, json({ id: t.id, reply: "fake staff reply" }))).status).toBe(403);
    expect((await ledgerBalance(d, "A")).total).toBe(100);
    expect((await d.select().from(users).where(eq(users.id, "A")))[0].plan).toBe("FREE");
    expect((await d.select().from(supportTickets))[0].adminReply).toBeNull();
    expect((await d.select().from(auditLog)).length).toBe(0);
  });
  it("an admin can adjust credits and plans, and it is audited", async () => {
    as("ADMIN"); h.admins.add("ADMIN");
    expect((await call(adminCredits.POST, json({ userId: "B", amount: 50, reason: "goodwill" }))).status).toBe(200);
    expect((await ledgerBalance(d, "B")).total).toBe(150);
    expect((await call(adminCredits.POST, json({ userId: "B", amount: -30, reason: "correction" }))).status).toBe(200);
    expect((await ledgerBalance(d, "B")).total).toBe(120);
    expect((await call(adminPlan.POST, json({ userId: "B", plan: "PRO" }))).status).toBe(200);
    const log = await d.select().from(auditLog);
    expect(log.map((l) => l.action).sort()).toEqual(["credits.grant", "credits.revoke", "plan.change"]);
    expect(log.every((l) => l.actorId === "ADMIN")).toBe(true);
  });
  it("the role comes from Clerk metadata, not from anything the client sends", async () => {
    as("A");
    const r = await call(adminCredits.POST, json({ userId: "A", amount: 5, reason: "x", role: "admin", isAdmin: true }));
    expect(r.status).toBe(403);
  });
  it("admin credit adjustments can't overdraw below zero", async () => {
    as("ADMIN"); h.admins.add("ADMIN");
    await call(adminCredits.POST, json({ userId: "B", amount: -500, reason: "too much" }));
    expect((await ledgerBalance(d, "B")).total).toBe(0);
  });
  it("rejects malformed admin input (400) instead of crashing", async () => {
    as("ADMIN"); h.admins.add("ADMIN");
    expect((await call(adminCredits.POST, json({ userId: "B", amount: 0, reason: "zero" }))).status).toBe(400);
    expect((await call(adminCredits.POST, json({ userId: "B", amount: 5 }))).status).toBe(400);
    expect((await call(adminPlan.POST, json({ userId: "B", plan: "ENTERPRISE" }))).status).toBe(400);
  });
});

describe("clients cannot grant themselves anything via payment status", () => {
  it("the status endpoint is read-only: polling a pending payment never changes plan or credits", async () => {
    await d.insert(payments).values({ userId: "A", provider: "paystack", reference: "ref_A", kind: "subscription", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", status: "pending" });
    as("A");
    for (let i = 0; i < 3; i++) await call(statusRoute.GET, new Request("http://x/api?ref=ref_A"));
    expect((await d.select().from(users).where(eq(users.id, "A")))[0].plan).toBe("FREE");
    expect((await ledgerBalance(d, "A")).total).toBe(100);
    expect((await d.select().from(creditLedger).where(eq(creditLedger.userId, "A"))).length).toBe(1);
  });
});
void (null as unknown as H);
