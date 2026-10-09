/**
 * /api/studio/session/end records WHY the browser ended a session (so Admin can tell Stop from a failed connection),
 * accepts only a fixed set of reasons, still works with no reason (older clients, the pagehide beacon), and only ever
 * touches the caller's own sessions. Real route handler, in-memory Postgres, Clerk's auth mocked.
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
import { CLIENT_END_REASONS } from "@/lib/session-end";
import * as endRoute from "@/app/api/studio/session/end/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

const OPEN = "00000000-0000-4000-8000-000000000001";
const OTHERS = "00000000-0000-4000-8000-000000000002";

beforeEach(async () => {
  h.me = "u";
  await d.execute(sql`truncate users, credit_ledger, studio_sessions, audit_log, notifications restart identity cascade`);
  await d.insert(users).values([{ id: "u", email: "u@x.co", name: "U", plan: "PRO" }, { id: "other", email: "o@x.co", name: "O", plan: "PRO" }]);
  await grantCredits(d, "u", 5000, "monthly", "seed");
  await d.insert(studioSessions).values([
    { id: OPEN, userId: "u", maxSeconds: 1800, startedAt: new Date(Date.now() - 20_000) },
    { id: OTHERS, userId: "other", maxSeconds: 1800, startedAt: new Date(Date.now() - 20_000) },
  ]);
});

const end = (body: unknown) => endRoute.POST(new Request("http://x/api/studio/session/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const row = async (id: string) => (await d.select().from(studioSessions).where(eq(studioSessions.id, id)))[0];

describe("ending a session", () => {
  it.each(CLIENT_END_REASONS)("records the reason %s and bills the time the session was open", async (reason) => {
    const res = await end({ sessionId: OPEN, reason });
    expect(res.status).toBe(200);
    expect(await row(OPEN)).toMatchObject({ endReason: reason });
    expect((await row(OPEN)).endedAt).not.toBeNull();
    expect((await row(OPEN)).secondsBilled).toBeGreaterThanOrEqual(19); // a failed attempt is billed for the time it was open
  });

  it("defaults to 'user' when no reason is sent", async () => {
    expect((await end({ sessionId: OPEN })).status).toBe(200);
    expect(await row(OPEN)).toMatchObject({ endReason: "user" });
  });

  it("rejects a reason outside the allowed set and leaves the session open (a client cannot write arbitrary text, or fake a server-side reason)", async () => {
    for (const reason of ["stale", "superseded", "credits", "anything I like", ""]) {
      expect((await end({ sessionId: OPEN, reason })).status).toBe(400);
    }
    expect((await row(OPEN)).endedAt).toBeNull();
  });

  it("ending twice is harmless: the first reason stands", async () => {
    await end({ sessionId: OPEN, reason: "connection_failed" });
    expect((await end({ sessionId: OPEN, reason: "user" })).status).toBe(200);
    expect(await row(OPEN)).toMatchObject({ endReason: "connection_failed" });
  });

  it("cannot end someone else's session", async () => {
    expect((await end({ sessionId: OTHERS, reason: "user" })).status).toBe(404);
    expect((await row(OTHERS)).endedAt).toBeNull();
  });
});
