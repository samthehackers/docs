/**
 * Integration tests against a REAL PostgreSQL via the production postgres-js driver and the real route handlers.
 *
 * Why this exists: the unit suites use an in-memory Postgres (PGlite), whose driver behaves differently from
 * postgres-js. Two production bugs slipped through that gap (a raw Date in an sql fragment broke the retention cron,
 * and tx.execute() returns a different shape). These tests run the same code the deployment runs.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so point it at a scratch database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
const SECRET = "integration-cron-secret-0123456789";
if (URL_) { process.env.DATABASE_URL = URL_; process.env.CRON_SECRET = SECRET; }

import { db } from "@/lib/db";
import { creditLedger, payments, studioSessions, transformations, users } from "@/db/schema";
import { debitCredits, grantCredits, ledgerBalance } from "@/lib/credits";
import { downgradeExpired, fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";
import { closeOpenSessions } from "@/lib/metering";
import { GET as refillRoute } from "@/app/api/cron/refill/route";
import { GET as retentionRoute } from "@/app/api/cron/retention/route";
import { GET as staleRoute } from "@/app/api/cron/stale-sessions/route";

const cron = (path: string) => new Request(`http://x/api/cron/${path}`, { headers: { authorization: `Bearer ${SECRET}` } });
const ago = (ms: number) => new Date(Date.now() - ms);
const MIN = 60_000, DAY = 86_400_000;

suite("real PostgreSQL (production driver)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, prepare: false });
    await migrate(drizzle(admin), { migrationsFolder: "db/migrations" }); // also proves the migrations apply to a real server
  });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    await db().execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, transformations, presets, support_tickets restart identity cascade`);
  });

  const user = (id: string, v: Partial<typeof users.$inferInsert> = {}) => db().insert(users).values({ id, email: `${id}@x.co`, name: id, ...v });

  describe("plan expiry (regression: raw Date parameter failed on postgres-js)", () => {
    it("downgradeExpired moves lapsed PRO to FREE, keeps purchased credits, and spares active PRO and LIFETIME", async () => {
      await user("lapsed", { plan: "PRO", planRenewsAt: ago(10 * DAY) });
      await user("active", { plan: "PRO", planRenewsAt: new Date(Date.now() + 10 * DAY) });
      await user("graced", { plan: "PRO", planRenewsAt: ago(1 * DAY) }); // inside the 2-day grace
      await user("forever", { plan: "LIFETIME" });
      await grantCredits(db(), "lapsed", 700, "purchased", "topup");
      expect(await downgradeExpired(db())).toBe(1);
      const plan = async (id: string) => (await db().select().from(users).where(eq(users.id, id)))[0].plan;
      expect(await plan("lapsed")).toBe("FREE");
      expect(await plan("active")).toBe("PRO");
      expect(await plan("graced")).toBe("PRO");
      expect(await plan("forever")).toBe("LIFETIME");
      expect((await ledgerBalance(db(), "lapsed")).purchased).toBe(700);
    });
  });

  describe("cron routes (real handlers, real driver)", () => {
    it("retention: purges expired history, downgrades lapsed plans, returns 200", async () => {
      await user("old-free");
      await user("lapsed", { plan: "PRO", planRenewsAt: ago(9 * DAY) });
      await db().insert(transformations).values([
        { userId: "old-free", title: "ancient", createdAt: ago(30 * DAY) }, // FREE keeps 7 days
        { userId: "old-free", title: "recent", createdAt: ago(1 * DAY) },
      ]); // no thumbnail/export paths, so nothing is sent to storage
      await db().insert(payments).values([
        { userId: "old-free", provider: "paystack", reference: "alt_stale", kind: "topup", product: "TOPUP_1K", amountMinor: 1, currency: "NGN", status: "pending", createdAt: ago(2 * DAY) },
        { userId: "old-free", provider: "paystack", reference: "alt_fresh", kind: "topup", product: "TOPUP_1K", amountMinor: 1, currency: "NGN", status: "pending", createdAt: ago(MIN) },
      ]);
      const res = await retentionRoute(cron("retention"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: 1, downgraded: 1, abandoned: 1 });
      expect((await db().select().from(payments).where(eq(payments.reference, "alt_stale")))[0].status).toBe("abandoned");
      expect((await db().select().from(payments).where(eq(payments.reference, "alt_fresh")))[0].status).toBe("pending");
      expect((await db().select().from(transformations)).map((t) => t.title)).toEqual(["recent"]);
    });

    it("refill: expires leftover monthly credits, grants the allowance, and is idempotent per month", async () => {
      await user("a"); await user("b", { plan: "PRO" });
      await grantCredits(db(), "a", 40, "monthly", "seed");
      await grantCredits(db(), "a", 9, "purchased", "topup");
      const first = await (await refillRoute(cron("refill"))).json();
      expect(first.refilled).toBe(2);
      expect(await ledgerBalance(db(), "a")).toMatchObject({ monthly: 300, purchased: 9 });
      expect(await ledgerBalance(db(), "b")).toMatchObject({ monthly: 6000 });
      expect((await (await refillRoute(cron("refill"))).json()).refilled).toBe(0);
      expect((await ledgerBalance(db(), "a")).monthly).toBe(300);
    });

    it("refill: a Lifetime member is refilled on the purchase's monthly anniversary (timestamps read through postgres-js)", async () => {
      await user("life", { plan: "LIFETIME" });
      await db().insert(creditLedger).values({ userId: "life", delta: 2000, bucket: "monthly", reason: "monthly_refill", refType: "refill", refId: "pay:alt_life", createdAt: ago(40 * DAY) });
      await db().update(users).set({ creditsMonthly: 2000 }).where(eq(users.id, "life"));
      expect((await (await refillRoute(cron("refill"))).json()).refilled).toBe(1);
      const refs = (await db().select().from(creditLedger).where(eq(creditLedger.userId, "life"))).map((r) => r.refId);
      expect(refs).toContain("cycle:pay:alt_life:1");
      expect((await (await refillRoute(cron("refill"))).json()).refilled).toBe(0);
    });

    it("stale-sessions: closes abandoned sessions billed only to their last heartbeat, leaves live ones open, is idempotent", async () => {
      await user("u"); await grantCredits(db(), "u", 500, "monthly", "seed");
      await db().insert(studioSessions).values([
        { id: "00000000-0000-4000-8000-000000000001", userId: "u", maxSeconds: 1800, startedAt: ago(12 * MIN), lastHeartbeatAt: ago(10 * MIN), secondsBilled: 100 }, // 120s elapsed at last heartbeat: owes 20
        { id: "00000000-0000-4000-8000-000000000002", userId: "u", maxSeconds: 1800, startedAt: ago(30_000), lastHeartbeatAt: ago(2_000), secondsBilled: 28 },
      ]);
      const res = await staleRoute(cron("stale-sessions"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: 1 });
      const rows = await db().select().from(studioSessions).orderBy(studioSessions.id);
      expect(rows[0]).toMatchObject({ secondsBilled: 120, endReason: "stale" });
      expect(rows[0].endedAt).not.toBeNull();
      expect(rows[1].endedAt).toBeNull();
      expect((await ledgerBalance(db(), "u")).total).toBe(480); // charged exactly the 20 s owed, nothing for the dead time
      expect(await (await staleRoute(cron("stale-sessions"))).json()).toEqual({ closed: 0 });
    });

    it("all three refuse a wrong or missing secret (401) and change nothing", async () => {
      await user("lapsed", { plan: "PRO", planRenewsAt: ago(9 * DAY) });
      for (const [route, name] of [[refillRoute, "refill"], [retentionRoute, "retention"], [staleRoute, "stale-sessions"]] as const) {
        expect((await route(new Request(`http://x/api/cron/${name}`))).status).toBe(401);
        expect((await route(new Request(`http://x/api/cron/${name}`, { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
      }
      expect((await db().select().from(users))[0].plan).toBe("PRO");
    });
  });

  describe("concurrency on a real server", () => {
    const base: FulfilInput = { provider: "paystack", eventId: "e1", eventType: "charge.success", payload: {}, reference: "r1", userId: "u", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN" };

    it("the same webhook delivered 8 times at once is applied exactly once", async () => {
      await user("u");
      const results = await Promise.all(Array.from({ length: 8 }, () => fulfilPayment(base)));
      expect(results.filter((r) => r === "applied")).toHaveLength(1);
      expect(results.filter((r) => r === "duplicate")).toHaveLength(7);
      expect((await ledgerBalance(db(), "u")).purchased).toBe(1000);
      expect((await db().select().from(payments)).length).toBe(1);
    });

    it("one payment reference arriving under different event ids at once still grants once", async () => {
      await user("u");
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => fulfilPayment({ ...base, eventId: `e${i}` })));
      expect(results.filter((r) => r === "applied")).toHaveLength(1);
      expect((await ledgerBalance(db(), "u")).purchased).toBe(1000);
    });

    it("concurrent debits can never overdraw, and the cached balance always equals the ledger", async () => {
      await user("u");
      await grantCredits(db(), "u", 10, "monthly", "seed");
      const debits = await Promise.all(Array.from({ length: 6 }, () => db().transaction((tx) => debitCredits(tx, "u", 8, "session"))));
      const taken = debits.reduce((n, d) => n + d.debited, 0);
      expect(taken).toBe(10); // 10 available in total, however the 6 racers interleave
      const bal = await ledgerBalance(db(), "u");
      expect(bal.total).toBe(0);
      const [u] = await db().select().from(users).where(eq(users.id, "u"));
      expect(u.creditsMonthly + u.creditsPurchased).toBe(bal.total);
      const neg = await db().select().from(creditLedger).where(sql`${creditLedger.delta} > 0 and ${creditLedger.reason} = 'session'`);
      expect(neg).toHaveLength(0);
    });
  });
  describe("starting a new session closes earlier ones the way the sweep would", () => {
    it("bills a silent session only to its last heartbeat, a live one to now, and leaves other users alone", async () => {
      await user("u"); await user("other");
      await grantCredits(db(), "u", 5000, "monthly", "seed");
      const mk = (userId: string, id: string, startedAgo: number, heartbeatAgo: number, billed: number) =>
        db().insert(studioSessions).values({ id, userId, maxSeconds: 1800, startedAt: ago(startedAgo * 1000), lastHeartbeatAt: ago(heartbeatAgo * 1000), secondsBilled: billed });
      const SILENT = "00000000-0000-4000-8000-0000000000a1", LIVE = "00000000-0000-4000-8000-0000000000a2", THEIRS = "00000000-0000-4000-8000-0000000000a3";
      await mk("u", SILENT, 1200, 1080, 120);   // went quiet after 120 s, 18 minutes ago
      await mk("other", THEIRS, 1200, 1080, 120);
      const before = (await ledgerBalance(db(), "u")).total;
      expect(await closeOpenSessions("u")).toBe(1);
      const get = async (id: string) => (await db().select().from(studioSessions).where(eq(studioSessions.id, id)))[0];
      expect(await get(SILENT)).toMatchObject({ endReason: "stale", secondsBilled: 120 });
      expect((await ledgerBalance(db(), "u")).total).toBe(before);
      expect((await get(THEIRS)).endedAt).toBeNull();

      await mk("u", LIVE, 40, 5, 35);
      expect(await closeOpenSessions("u")).toBe(1);
      const live = await get(LIVE);
      expect(live.endReason).toBe("superseded");
      expect(live.secondsBilled).toBeGreaterThanOrEqual(40);
      expect(live.secondsBilled).toBeLessThanOrEqual(42);
    });
  });
});
