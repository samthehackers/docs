/**
 * The Lifetime-after-Pro sequence on a REAL PostgreSQL through the production driver, with only the payment provider
 * faked: the subscription is cancelled at the provider when Lifetime is bought, and a later Pro charge cannot turn
 * Lifetime back into Pro. See tests/unit/lifetime-subscription.test.ts for the full rule set.
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

const h = vi.hoisted(() => ({ cancel: vi.fn(async (_id: string, _token?: string) => {}) }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ cancelSubscription: h.cancel }) }));

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
if (URL_) { process.env.DATABASE_URL = URL_; }

import { db } from "@/lib/db";
import { auditLog, subscriptions, users } from "@/db/schema";
import { fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";

suite("Lifetime bought on top of a Pro subscription (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => { admin = postgres(URL_!, { max: 1, prepare: false }); await migrate(drizzle(admin), { migrationsFolder: "db/migrations" }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    h.cancel.mockClear();
    await db().execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, referrals restart identity cascade`);
    await db().insert(users).values({ id: "u", email: "u@x.co", name: "U" });
  });
  const pay = (over: Partial<FulfilInput>): FulfilInput => ({ provider: "paystack", eventId: "e", eventType: "charge.success", payload: {}, reference: "r", userId: "u", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", ...over });

  it("cancels at the provider, then keeps Lifetime when a Pro charge still arrives", async () => {
    await fulfilPayment(pay({ eventId: "e1", reference: "pro1", sub: { id: "SUB_1", emailToken: "tok" } }));
    await fulfilPayment(pay({ eventId: "e2", reference: "life1", product: "LIFETIME", amountMinor: 9900000 }));
    expect(h.cancel).toHaveBeenCalledWith("SUB_1", "tok");
    expect((await db().select().from(subscriptions))[0].status).toBe("cancelled");

    // simultaneous duplicate deliveries of the late Pro charge: held once, plan untouched
    await Promise.all(Array.from({ length: 4 }, () => fulfilPayment(pay({ eventId: "ren", reference: "renew1" }))));
    const [u] = await db().select().from(users).where(eq(users.id, "u"));
    expect(u.plan).toBe("LIFETIME");
    expect(u.planRenewsAt).toBeNull();
    expect((await db().select().from(auditLog)).filter((a) => a.action === "payment.after_lifetime")).toHaveLength(1);
  });
});
