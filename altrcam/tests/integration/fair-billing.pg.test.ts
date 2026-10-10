/**
 * Fair billing under real concurrency, on a REAL PostgreSQL through the production driver. The unit suite
 * (tests/unit/fair-billing.test.ts) proves the rules on PGlite, which runs on one connection and so cannot show what the
 * row locks do when requests really overlap: a double-clicked Stop, a heartbeat racing the end call, two tabs reporting
 * the first frame, several sessions ending at once against the daily refund limit.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so use a scratch database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
if (URL_) process.env.DATABASE_URL = URL_;

import { db } from "@/lib/db";
import { auditLog, creditLedger, studioSessions, users } from "@/db/schema";
import { grantCredits, ledgerBalance } from "@/lib/credits";
import { closeOpenSessions, markLive, meterSession, sweepStaleSessions } from "@/lib/metering";
import { REFUNDS_PER_DAY } from "@/lib/plans";

const ago = (s: number) => new Date(Date.now() - s * 1000);
let seq = 0;
const newId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

suite("fair billing under concurrency (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => { admin = postgres(URL_!, { max: 1, prepare: false }); await migrate(drizzle(admin), { migrationsFolder: "db/migrations" }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    await db().execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, referrals restart identity cascade`);
    await db().insert(users).values({ id: "u", email: "u@x.co", name: "U", plan: "PRO" });
    await grantCredits(db(), "u", 5000, "monthly", "seed");
  });

  const session = async (startedAgo: number, liveAgo: number | null, v: Partial<typeof studioSessions.$inferInsert> = {}) => {
    const id = newId();
    await db().insert(studioSessions).values({ id, userId: "u", maxSeconds: 1800, startedAt: ago(startedAgo), liveAt: liveAgo === null ? null : ago(liveAgo), lastHeartbeatAt: ago(1), ...v });
    return id;
  };
  const row = async (id: string) => (await db().select().from(studioSessions).where(eq(studioSessions.id, id)))[0];
  /** The ledger and the cached balance must agree, and session debits must equal what the sessions say they billed. */
  async function consistent() {
    const bal = await ledgerBalance(db(), "u");
    const [u] = await db().select().from(users).where(eq(users.id, "u"));
    expect(u.creditsMonthly + u.creditsPurchased).toBe(bal.total);
    const [{ debits }] = await db().select({ debits: sql<number>`coalesce(-sum(${creditLedger.delta}),0)::int` }).from(creditLedger).where(eq(creditLedger.reason, "session"));
    const [{ billed }] = await db().select({ billed: sql<number>`coalesce(sum(${studioSessions.secondsBilled}),0)::int` }).from(studioSessions);
    expect(debits).toBe(billed);
    return bal.total;
  }

  it("8 heartbeats at the same moment bill each live second exactly once", async () => {
    const id = await session(45, 40); // live for 40 s, nothing billed yet
    const now = new Date();
    const rs = await Promise.all(Array.from({ length: 8 }, () => meterSession(id, "u", { now })));
    expect(rs.every((r) => r !== null)).toBe(true);
    expect((await row(id)).secondsBilled).toBe(40);
    expect(await consistent()).toBe(5000 - 40);
    expect(await db().select().from(creditLedger).where(eq(creditLedger.refId, id))).toHaveLength(1); // one debit row, not eight
  });

  it("a heartbeat racing the end call (and a double-clicked Stop) never bills a second twice", async () => {
    const id = await session(25, 20);
    const now = new Date();
    await Promise.all([meterSession(id, "u", { now }), meterSession(id, "u", { now, end: "user" }), meterSession(id, "u", { now, end: "user" })]);
    const r = await row(id);
    expect(r.endedAt).not.toBeNull();
    expect(r.secondsBilled).toBe(20);
    expect(await consistent()).toBe(5000 - 20);
  });

  it("two first-frame reports at once set live_at exactly once; both get the same time", async () => {
    const id = await session(5, null);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => markLive(id, "u", new Date(Date.now() + i * 7))));
    const times = rs.map((r) => (r.status === "live" ? r.liveAt.getTime() : -1));
    expect(new Set(times).size).toBe(1);
    expect(rs.filter((r) => r.status === "live" && !r.already)).toHaveLength(1);
    expect((await row(id)).liveAt!.getTime()).toBe(times[0]);
  });

  it("the same early-drop end call sent 6 times at once refunds exactly once", async () => {
    const id = await session(8, 6);
    await meterSession(id, "u", { now: ago(1) }); // a heartbeat billed 5 s
    const rs = await Promise.all(Array.from({ length: 6 }, () => meterSession(id, "u", { end: "connection_failed", failure: "ice_failed" })));
    const charged = (await row(id)).secondsBilled;
    expect(rs.filter((r) => r!.reason === "connection_failed" && r!.refunded === charged)).toHaveLength(6); // all report the one refund
    expect((await db().select().from(creditLedger).where(eq(creditLedger.reason, "session_refund")))).toHaveLength(1);
    expect((await db().select().from(auditLog).where(eq(auditLog.action, "session.refund")))).toHaveLength(1);
    expect(await consistent()).toBe(5000); // charged, then all given back
  });

  it(`${REFUNDS_PER_DAY + 3} early drops of different sessions ending at once: only ${REFUNDS_PER_DAY} are refunded`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < REFUNDS_PER_DAY + 3; i++) ids.push(await session(9, 7, { lastHeartbeatAt: ago(1) }));
    for (const id of ids) await meterSession(id, "u", { now: ago(2) }); // each billed 5 s by a heartbeat
    const rs = await Promise.all(ids.map((id) => meterSession(id, "u", { end: "connection_failed", failure: "socket_error" })));
    expect(rs.filter((r) => r!.refunded > 0)).toHaveLength(REFUNDS_PER_DAY);
    expect((await db().select().from(auditLog).where(eq(auditLog.action, "session.refund_refused")))).toHaveLength(3);
    const total = await consistent();
    const refunded = rs.reduce((n, r) => n + r!.refunded, 0);
    const [{ billed }] = await db().select({ billed: sql<number>`sum(${studioSessions.secondsBilled})::int` }).from(studioSessions);
    expect(total).toBe(5000 - billed + refunded);
  });

  it("the sweep and a new start closing the same never-live session at once: closed once, failed_connect, nothing billed", async () => {
    const id = await session(45, null);
    await Promise.all([sweepStaleSessions(), closeOpenSessions("u"), sweepStaleSessions()]);
    expect(await row(id)).toMatchObject({ endReason: "failed_connect", secondsBilled: 0, liveAt: null });
    expect(await consistent()).toBe(5000);
  });

  it("a first-frame report racing the 30 s cut-off either goes live or is closed unbilled, never both", async () => {
    const id = await session(29.9, null);
    const [live] = await Promise.all([markLive(id, "u"), sweepStaleSessions(new Date(Date.now() + 200))]);
    const r = await row(id);
    if (live.status === "live") expect(r.liveAt).not.toBeNull();
    else expect(r).toMatchObject({ endReason: "failed_connect", liveAt: null });
    expect(!!r.liveAt && r.endReason === "failed_connect").toBe(false);
    expect(await consistent()).toBe(5000);
  });

  it("migration 0005 gave every pre-existing session a live time equal to its start (how it was billed)", async () => {
    // Simulate a row written before the migration, then run the migration's backfill statement again.
    const id = await session(100, null, { endedAt: ago(10), endReason: "user", secondsBilled: 90 });
    await db().execute(sql`UPDATE "studio_sessions" SET "live_at" = "started_at" WHERE "live_at" IS NULL`);
    const r = await row(id);
    expect(r.liveAt!.getTime()).toBe(r.startedAt.getTime());
  });
});
