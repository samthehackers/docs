/**
 * Fair billing (owner's spec A3): a session is created "connecting" with no debit, goes live when the browser reports
 * the first transformed frame (POST /api/studio/session/live, server clock), and is billed only from then.
 *
 * Real route handlers and lib/metering.ts against an in-memory Postgres (PGlite) with Clerk's auth mocked. PGlite runs
 * on ONE connection, so it cannot show what row locks do under real concurrency: that is in
 * tests/integration/fair-billing.pg.test.ts (real PostgreSQL).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.me }),
  clerkClient: async () => ({ users: { getUser: async () => ({ publicMetadata: {} }), deleteUser: async () => {} } }),
  clerkMiddleware: () => () => {}, createRouteMatcher: () => () => false, currentUser: async () => null,
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { studioSessions, users } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import * as liveRoute from "@/app/api/studio/session/live/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; process.env.FAL_KEY = "test-key"; }, 60_000);

let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const ago = (s: number) => new Date(Date.now() - s * 1000);
const post = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) =>
  route.POST(new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const row = async (id: string) => (await d.select().from(studioSessions).where(eq(studioSessions.id, id)))[0];

beforeEach(async () => {
  h.me = "u";
  await d.execute(sql`truncate users, credit_ledger, studio_sessions, audit_log, notifications restart identity cascade`);
  await d.insert(users).values([{ id: "u", email: "u@x.co", name: "U", plan: "PRO" }, { id: "other", email: "o@x.co", name: "O", plan: "PRO" }]);
  await grantCredits(d, "u", 5000, "monthly", "seed");
  await grantCredits(d, "other", 5000, "monthly", "seed");
});

/** An open session that started `startedAgo` s ago; live `liveAgo` s ago (null: still connecting). */
async function session(userId: string, startedAgo: number, liveAgo: number | null, v: Partial<typeof studioSessions.$inferInsert> = {}) {
  const id = newId();
  await d.insert(studioSessions).values({ id, userId, maxSeconds: 1800, startedAt: ago(startedAgo), lastHeartbeatAt: ago(Math.min(startedAgo, 2)), liveAt: liveAgo === null ? null : ago(liveAgo), ...v });
  return id;
}

describe("POST /api/studio/session/live", () => {
  it("records the server time once; a second call is idempotent and keeps the first time", async () => {
    const id = await session("u", 5, null);
    const r1 = await post(liveRoute, { sessionId: id });
    expect(r1.status).toBe(200);
    const first = (await row(id)).liveAt!;
    expect(Math.abs(first.getTime() - Date.now())).toBeLessThan(2000);
    expect(await r1.json()).toMatchObject({ alreadyLive: false, liveAt: first.toISOString() });
    await new Promise((r) => setTimeout(r, 15));
    const r2 = await post(liveRoute, { sessionId: id });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ alreadyLive: true, liveAt: first.toISOString() });
    expect((await row(id)).liveAt!.getTime()).toBe(first.getTime());
  });

  it("counts as a heartbeat", async () => {
    const id = await session("u", 5, null, { lastHeartbeatAt: ago(5) });
    await post(liveRoute, { sessionId: id });
    expect(Date.now() - (await row(id)).lastHeartbeatAt.getTime()).toBeLessThan(2000);
  });

  it("cannot mark another user's session live: 404, and their session is untouched", async () => {
    const theirs = await session("other", 5, null);
    const res = await post(liveRoute, { sessionId: theirs });
    expect(res.status).toBe(404);
    expect((await row(theirs)).liveAt).toBeNull();
  });

  it("refuses a session that has already ended (409) and leaves it as it was", async () => {
    const id = await session("u", 60, null, { endedAt: ago(30), endReason: "user" });
    const res = await post(liveRoute, { sessionId: id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ended", reason: "user" });
    expect((await row(id)).liveAt).toBeNull();
  });

  it("needs a signed-in user and a valid session id", async () => {
    const id = await session("u", 5, null);
    h.me = null;
    expect((await post(liveRoute, { sessionId: id })).status).toBe(401);
    h.me = "u";
    expect((await post(liveRoute, { sessionId: "not-a-uuid" })).status).toBe(400);
    expect((await post(liveRoute, { sessionId: newId() })).status).toBe(404);
    expect((await row(id)).liveAt).toBeNull();
  });
});
