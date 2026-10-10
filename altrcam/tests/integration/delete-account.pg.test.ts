/**
 * Deleting an account while other things are happening to it, on a REAL PostgreSQL through the production driver.
 * Lock order is only observable here: the in-memory test database runs on a single connection and cannot deadlock.
 * Deleting must not deadlock with a live session's heartbeat (meterSession) or with the user's own payment being
 * confirmed (fulfilPayment). Only storage, the Supabase Auth admin client and the payment provider are faked.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so use a scratch database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), deleteUserFiles: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdminConfig: () => null, createAdminClient: () => { throw new Error("not in this test"); } }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ cancelSubscription: async () => {} }) }));

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
if (URL_) { process.env.DATABASE_URL = URL_; process.env.PRICE_CURRENCY = "NGN"; }

import { db } from "@/lib/db";
import { payments, studioSessions, users } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import { deleteAccount } from "@/lib/users";
import { meterSession } from "@/lib/metering";
import { fulfilPayment } from "@/lib/payments/fulfil";

const ROUNDS = 14;
const deadlocks = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "rejected" && /deadlock/i.test(String((r as PromiseRejectedResult).reason))).length;

suite("deleteAccount versus concurrent activity (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => { admin = postgres(URL_!, { max: 1, prepare: false }); await migrate(drizzle(admin), { migrationsFolder: "db/migrations" }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    await db().execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, referrals restart identity cascade`);
  });

  it("never deadlocks with a live session's heartbeat", async () => {
    let dead = 0;
    for (let n = 0; n < ROUNDS; n++) {
      const id = `u${n}`, sid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      await db().insert(users).values({ id, email: `${id}@x.co`, name: id });
      await grantCredits(db(), id, 500, "monthly", "seed");
      await db().insert(studioSessions).values({ id: sid, userId: id, maxSeconds: 1800, startedAt: new Date(Date.now() - 30_000) });
      const rs = await Promise.allSettled([meterSession(sid, id), deleteAccount(id, { deleteAuthUser: false })]);
      dead += deadlocks(rs);
      expect(rs[1].status, `round ${n}: delete should succeed`).toBe("fulfilled");
    }
    expect(dead).toBe(0);
  }, 90_000);

  it("never deadlocks with the user's own payment being confirmed", async () => {
    let dead = 0;
    for (let n = 0; n < ROUNDS; n++) {
      const id = `p${n}`, ref = `ref${n}`;
      await db().insert(users).values({ id, email: `${id}@x.co`, name: id });
      await db().insert(payments).values({ userId: id, provider: "paystack", reference: ref, kind: "subscription", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", status: "pending" });
      const rs = await Promise.allSettled([
        fulfilPayment({ provider: "paystack", eventId: `ev${n}`, eventType: "charge.success", payload: {}, reference: ref, userId: id, product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN" }),
        deleteAccount(id, { deleteAuthUser: false }),
      ]);
      dead += deadlocks(rs);
      expect(rs[1].status, `round ${n}: delete should succeed`).toBe("fulfilled");
      // A payment confirmed after the account is gone may fail on the missing user (that is not a deadlock).
      expect((await db().select().from(users).where(eq(users.id, id))).length).toBe(0);
    }
    expect(dead).toBe(0);
  }, 90_000);
});
