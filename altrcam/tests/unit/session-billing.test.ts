/**
 * Starting a new session closes any earlier open one. If that earlier session had gone silent (no heartbeat for
 * longer than STALE_AFTER_SECONDS, e.g. the tab or computer crashed), it must be billed exactly as the stale sweep
 * would bill it: up to its LAST HEARTBEAT, not up to "now". Otherwise the bill depends on whether a best-effort
 * cron happened to run before the user clicked Start, and a user whose laptop died can be charged up to their
 * plan's whole session length for time they were not connected.
 *
 * Drives the real route handler against an in-memory Postgres with Clerk's auth mocked.
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
import { grantCredits, ledgerBalance } from "@/lib/credits";
import { STALE_AFTER_SECONDS } from "@/lib/plans";
import { sweepStaleSessions } from "@/lib/metering";
import * as startRoute from "@/app/api/studio/session/start/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; process.env.FAL_KEY = "test-key"; }, 60_000);

const NOW = () => Date.now();
const ago = (s: number) => new Date(NOW() - s * 1000);
let seq = 0;
const sid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeEach(async () => {
  h.me = null;
  await d.execute(sql`truncate users, credit_ledger, studio_sessions, audit_log, notifications restart identity cascade`);
  await d.insert(users).values([{ id: "u", email: "u@x.co", name: "U", plan: "PRO" }, { id: "other", email: "o@x.co", name: "O", plan: "PRO" }]);
  await grantCredits(d, "u", 5000, "monthly", "seed");
  await grantCredits(d, "other", 5000, "monthly", "seed");
});

/** An open session that started `startedAgo` s ago, last heartbeat `heartbeatAgo` s ago, billed `billed` s so far. */
async function openSession(userId: string, startedAgo: number, heartbeatAgo: number, billed: number) {
  const id = sid();
  await d.insert(studioSessions).values({ id, userId, maxSeconds: 1800, startedAt: ago(startedAgo), lastHeartbeatAt: ago(heartbeatAgo), secondsBilled: billed });
  return id;
}
const row = async (id: string) => (await d.select().from(studioSessions).where(eq(studioSessions.id, id)))[0];
const start = async () => {
  h.me = "u";
  return startRoute.POST(new Request("http://x/api/studio/session/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
};

describe("starting a session while an earlier one is open", () => {
  it("bills a silent (crashed) session only up to its last heartbeat, not up to now", async () => {
    // Started 20 min ago, went silent after 120 s (billed 120). The old behaviour billed the remaining 18 minutes.
    const old = await openSession("u", 1200, 1200 - 120, 120);
    const before = (await ledgerBalance(d, "u")).total;
    const res = await start();
    expect(res.status).toBe(200);
    const closed = await row(old);
    expect(closed.endedAt).not.toBeNull();
    expect(closed.endReason).toBe("stale");
    expect(closed.secondsBilled).toBe(120);
    expect((await ledgerBalance(d, "u")).total).toBe(before); // nothing extra charged for the silence
  });

  it("a session that never sent a heartbeat is not billed for the time since it started", async () => {
    const old = await openSession("u", 600, 600, 0);
    const before = (await ledgerBalance(d, "u")).total;
    expect((await start()).status).toBe(200);
    expect(await row(old)).toMatchObject({ endReason: "stale", secondsBilled: 0 });
    expect((await ledgerBalance(d, "u")).total).toBe(before);
  });

  it("a live session (recent heartbeat) is still settled up to now and marked superseded", async () => {
    const old = await openSession("u", 40, 5, 35);
    const before = (await ledgerBalance(d, "u")).total;
    expect((await start()).status).toBe(200);
    const closed = await row(old);
    expect(closed.endReason).toBe("superseded");
    expect(closed.secondsBilled).toBeGreaterThanOrEqual(40); // billed through the moment the new one started
    expect(closed.secondsBilled).toBeLessThanOrEqual(42);
    expect(before - (await ledgerBalance(d, "u")).total).toBe(closed.secondsBilled - 35);
  });

  it("uses the same cut-off as the sweep: just inside it is live, just past it is stale", async () => {
    const live = await openSession("u", 100, STALE_AFTER_SECONDS - 3, 100 - (STALE_AFTER_SECONDS - 3));
    expect((await start()).status).toBe(200);
    expect((await row(live)).endReason).toBe("superseded");

    const stale = await openSession("u", 100, STALE_AFTER_SECONDS + 3, 100 - (STALE_AFTER_SECONDS + 3));
    expect((await start()).status).toBe(200);
    expect((await row(stale)).endReason).toBe("stale");
  });

  it("bills a silent session exactly as the sweep would, whichever gets there first", async () => {
    const viaStart = await openSession("u", 900, 900 - 200, 200);
    const viaSweep = await openSession("other", 900, 900 - 200, 200);
    await start();
    await sweepStaleSessions();
    const a = await row(viaStart), b = await row(viaSweep);
    expect({ reason: a.endReason, billed: a.secondsBilled }).toEqual({ reason: b.endReason, billed: b.secondsBilled });
    expect(a.secondsBilled).toBe(200);
  });

  it("leaves other people's open sessions alone", async () => {
    const theirs = await openSession("other", 900, 900 - 50, 50);
    expect((await start()).status).toBe(200);
    expect((await row(theirs)).endedAt).toBeNull();
  });

  it("still creates the new session and returns the plan limits", async () => {
    await openSession("u", 1200, 1100, 100);
    const res = await start();
    const body = await res.json();
    expect(body).toMatchObject({ maxSeconds: 1800, resolution: "high" });
    const open = (await d.select().from(studioSessions).where(eq(studioSessions.userId, "u"))).filter((s) => !s.endedAt);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(body.sessionId);
  });
});
