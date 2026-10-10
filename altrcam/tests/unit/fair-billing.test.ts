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
// The proxy's own guard is what is tested; what it would forward to fal is replaced by a canned token.
vi.mock("@fal-ai/server-proxy/nextjs", () => ({ createRouteHandler: () => ({ POST: async () => new Response(JSON.stringify("tok"), { status: 200 }) }) }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { studioSessions, users } from "@/db/schema";
import { grantCredits, ledgerBalance } from "@/lib/credits";
import { CONNECT_GRACE_SECONDS, NEVER_LIVE_LIMIT, NEVER_LIVE_WINDOW_SECONDS } from "@/lib/plans";
import { activeSession, closeOpenSessions, sweepStaleSessions } from "@/lib/metering";
import * as liveRoute from "@/app/api/studio/session/live/route";
import * as heartbeatRoute from "@/app/api/studio/session/heartbeat/route";
import * as endRoute from "@/app/api/studio/session/end/route";
import * as startRoute from "@/app/api/studio/session/start/route";
import * as proxyRoute from "@/app/api/fal/proxy/route";

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

const GRACE = CONNECT_GRACE_SECONDS;
const balance = async (u = "u") => (await ledgerBalance(d, u)).total;

describe("a session that never goes live within the connect window (A3.3)", () => {
  it("heartbeat: while connecting it is kept open and debits nothing", async () => {
    const id = await session("u", 12, null);
    const res = await post(heartbeatRoute, { sessionId: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ continue: true, remaining: 5000, secondsLeftInSession: 1800 });
    expect((await row(id)).endedAt).toBeNull();
    expect(await balance()).toBe(5000);
  });

  it("heartbeat: past the window it is closed as failed_connect with 0 credits", async () => {
    const id = await session("u", GRACE + 1, null);
    const res = await post(heartbeatRoute, { sessionId: id });
    expect(await res.json()).toMatchObject({ continue: false, reason: "failed_connect", remaining: 5000 });
    expect(await row(id)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0, liveAt: null });
    expect((await row(id)).endedAt).not.toBeNull();
    expect(await balance()).toBe(5000);
  });

  it("end: past the window it is failed_connect whatever the browser says; a failure is failed_connect at any age; a Stop inside the window stays a Stop", async () => {
    const late = await session("u", GRACE + 5, null);
    const failed = await session("u", 8, null);
    const stopped = await session("u", 8, null);
    await post(endRoute, { sessionId: late, reason: "user" });
    await post(endRoute, { sessionId: failed, reason: "connection_failed" });
    await post(endRoute, { sessionId: stopped, reason: "user" });
    expect(await row(late)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0 });
    expect(await row(failed)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0 });
    expect(await row(stopped)).toMatchObject({ endReason: "user", secondsBilled: 0 });
    expect(await balance()).toBe(5000);
  });

  it("next start (supersede): a connecting session past the window is failed_connect, one inside it is superseded, both with 0", async () => {
    const late = await session("u", GRACE + 2, null);
    expect(await closeOpenSessions("u")).toBe(1);
    expect(await row(late)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0 });
    const fresh = await session("u", 5, null);
    await closeOpenSessions("u");
    expect(await row(fresh)).toMatchObject({ endReason: "superseded", secondsBilled: 0 });
    expect(await balance()).toBe(5000);
  });

  it("stale sweep: closes never-live sessions past the window with 0 (even while they still heartbeat), bills live ones only to their last heartbeat, leaves the rest", async () => {
    const neverLive = await session("u", GRACE + 3, null, { lastHeartbeatAt: ago(1) }); // still heartbeating, never live
    const neverLiveSilent = await session("other", 300, null, { lastHeartbeatAt: ago(290) });
    const connecting = await session("u", 10, null, { lastHeartbeatAt: ago(1) });
    const liveStale = await session("other", 200, 190, { lastHeartbeatAt: ago(140), secondsBilled: 40 }); // live 50 s at its last heartbeat: owes 10
    const liveFresh = await session("u", 60, 50, { lastHeartbeatAt: ago(3), secondsBilled: 40 });
    const before = { u: await balance("u"), other: await balance("other") };
    expect(await sweepStaleSessions()).toBe(3);
    expect(await row(neverLive)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0 });
    expect(await row(neverLiveSilent)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0 });
    expect((await row(connecting)).endedAt).toBeNull();
    expect(await row(liveStale)).toMatchObject({ endReason: "stale", secondsBilled: 50 });
    expect((await row(liveFresh)).endedAt).toBeNull();
    expect(await balance("u")).toBe(before.u);
    expect(await balance("other")).toBe(before.other - 10);
    expect(await sweepStaleSessions()).toBe(0); // idempotent
  });

  it("/live after the window is refused and closes the session as failed_connect, unbilled", async () => {
    const id = await session("u", GRACE + 1, null);
    const res = await post(liveRoute, { sessionId: id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "failed_connect", reason: "failed_connect" });
    expect(await row(id)).toMatchObject({ endReason: "failed_connect", liveAt: null, secondsBilled: 0 });
    expect((await post(heartbeatRoute, { sessionId: id })).status).toBe(200);
    expect(await balance()).toBe(5000);
  });
});

describe("the fal proxy only mints tokens for a session that is live or still connecting inside its window", () => {
  const mint = (sessionId: string | null, ttl: unknown = 120) => proxyRoute.POST(new Request("http://x/api/fal/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fal-target-url": "https://rest.fal.ai/tokens/", ...(sessionId ? { "x-altrcam-session": sessionId } : {}) },
    body: JSON.stringify({ allowed_apps: ["lucy-2-5"], ...(ttl === "none" ? {} : { token_expiration: ttl }) }),
  }) as never);

  it("connecting inside the window, and live: allowed", async () => {
    expect((await mint(await session("u", 5, null))).status).toBe(200);
    expect((await mint(await session("u", 600, 590))).status).toBe(200);
  });

  it("connecting past the window, ended, silent, someone else's, or no session: refused (403)", async () => {
    expect((await mint(await session("u", GRACE + 1, null))).status).toBe(403);
    expect((await mint(await session("u", 60, 50, { endedAt: ago(1), endReason: "user" }))).status).toBe(403);
    expect((await mint(await session("u", 600, 590, { lastHeartbeatAt: ago(45) }))).status).toBe(403); // live but gone quiet
    expect((await mint(await session("other", 5, null))).status).toBe(403);
    expect((await mint(null)).status).toBe(403);
  });

  it("activeSession agrees at the edge of the window", async () => {
    const id = await session("u", 0, null);
    const started = (await row(id)).startedAt.getTime();
    expect(await activeSession(id, "u", new Date(started + GRACE * 1000 - 1))).toBe(true);
    expect(await activeSession(id, "u", new Date(started + GRACE * 1000))).toBe(false);
  });

  it("refuses a token lifetime longer than the Studio asks for, or none", async () => {
    const id = await session("u", 5, null);
    expect((await mint(id, 121)).status).toBe(400);
    expect((await mint(id, 300)).status).toBe(400);
    expect((await mint(id, "none")).status).toBe(400);
    expect((await mint(id, 0)).status).toBe(400);
    expect((await mint(id, 120)).status).toBe(200);
  });
});

describe("the never-connected cooldown on Go live", () => {
  const start = () => post(startRoute, {});
  /** `n` sessions of `userId` that started `startedAgo` s ago (and a second apart) and were closed without going live. */
  const failures = async (n: number, startedAgo: number, userId = "u") => {
    for (let i = 0; i < n; i++) await session(userId, startedAgo + i, null, { endedAt: ago(startedAgo + i - 15), endReason: "failed_connect" });
  };

  it(`allows ${NEVER_LIVE_LIMIT} never-live sessions in the window`, async () => {
    await failures(NEVER_LIVE_LIMIT, 60);
    expect((await start()).status).toBe(200);
  });

  it("refuses the next start with 429, a reason, and how long to wait", async () => {
    await failures(NEVER_LIVE_LIMIT + 1, 60);
    const res = await start();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("connect_cooldown");
    expect(body.error).toMatch(/didn't connect.*paused.*Nothing was charged/);
    // The oldest of the 6 started 65 s ago, so it leaves the 10-minute window in about 535 s.
    expect(body.retryAfterSeconds).toBeGreaterThan(NEVER_LIVE_WINDOW_SECONDS - 70);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(NEVER_LIVE_WINDOW_SECONDS - 64);
    expect((await d.select().from(studioSessions).where(eq(studioSessions.userId, "u"))).filter((s) => !s.endedAt)).toHaveLength(0); // nothing created
  });

  it("counts a never-live Stop too (a tampered client could end every attempt that way), but not live sessions, old ones, open ones or other users'", async () => {
    for (let i = 0; i < NEVER_LIVE_LIMIT + 1; i++) await session("u", 30 + i, null, { endedAt: ago(25), endReason: "user" });
    expect((await start()).status).toBe(429);
    await d.execute(sql`truncate studio_sessions`);
    await failures(NEVER_LIVE_LIMIT, 60);
    await session("u", 120, 115, { endedAt: ago(90), endReason: "user" }); // went live: does not count
    await session("u", 5, null); // still open: does not count (the start closes it)
    await failures(3, NEVER_LIVE_WINDOW_SECONDS + 30); // outside the window
    await failures(NEVER_LIVE_LIMIT + 1, 60, "other");
    expect((await start()).status).toBe(200);
  });
});
