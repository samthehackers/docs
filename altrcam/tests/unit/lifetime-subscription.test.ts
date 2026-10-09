/**
 * Buying Lifetime while on a Pro subscription. The subscription must be cancelled AT THE PROVIDER (marking our own
 * row 'cancelled' stops nothing), and a Pro charge that still arrives afterwards must never turn Lifetime back into Pro.
 * Provider calls are faked; everything else is the real fulfilment code on an in-memory Postgres.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ cancel: vi.fn(async (_id: string, _token?: string) => {}) }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ cancelSubscription: h.cancel }) }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, notifications, payments, subscriptions, users } from "@/db/schema";
import { fulfilPayment, type FulfilInput } from "@/lib/payments/fulfil";
import { ledgerBalance } from "@/lib/credits";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
  process.env.PRICE_CURRENCY = "NGN";
  h.cancel.mockReset(); h.cancel.mockImplementation(async () => {});
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
  await d.insert(users).values({ id: "u", email: "u@x.co", name: "U" });
});

const pay = (over: Partial<FulfilInput>): FulfilInput => ({
  provider: "paystack", eventId: "e", eventType: "charge.success", payload: {}, reference: "r",
  userId: "u", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN", ...over,
});
const subscribe = () => fulfilPayment(pay({ eventId: "e1", reference: "pro1", sub: { id: "SUB_1", emailToken: "secret-email-token" } }), d);
const buyLifetime = () => fulfilPayment(pay({ eventId: "e2", reference: "life1", product: "LIFETIME", amountMinor: 9900000 }), d);
const renewal = (n = 1) => fulfilPayment(pay({ eventId: `ren${n}`, reference: `renew${n}` }), d); // a later charge, no subscription payload
const user = async () => (await d.select().from(users).where(eq(users.id, "u")))[0];
const audit = async (action: string) => (await d.select().from(auditLog)).filter((a) => a.action === action);

describe("Lifetime bought while a Pro subscription is active", () => {
  it("cancels the subscription at the provider, with the stored token", async () => {
    await subscribe();
    expect(await buyLifetime()).toBe("applied");
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel).toHaveBeenCalledWith("SUB_1", "secret-email-token");
    expect((await user()).plan).toBe("LIFETIME");
    expect((await d.select().from(subscriptions))[0].status).toBe("cancelled");
  });

  it("does not call the provider when there was no subscription, or when the webhook is a replay", async () => {
    expect(await buyLifetime()).toBe("applied");
    expect(h.cancel).not.toHaveBeenCalled();

    await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
    await d.insert(users).values({ id: "u", email: "u@x.co", name: "U" });
    await subscribe(); await buyLifetime(); await buyLifetime(); await buyLifetime();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it("a provider failure never undoes the purchase; it is audited, the user is told, and the token is not logged", async () => {
    await subscribe();
    h.cancel.mockRejectedValueOnce(new Error("paystack 500"));
    expect(await buyLifetime()).toBe("applied");
    expect((await user()).plan).toBe("LIFETIME");
    const failed = await audit("subscription.cancel_failed");
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0].meta)).toContain("SUB_1");
    expect(JSON.stringify(failed[0].meta)).not.toContain("secret-email-token");
    const notes = await d.select().from(notifications).where(eq(notifications.userId, "u"));
    expect(notes.some((n) => /cancel/i.test(n.title))).toBe(true);
  });
});

describe("a Pro charge that arrives after Lifetime", () => {
  it("never turns Lifetime back into Pro, and leaves credits, renewal date and plan alone", async () => {
    await subscribe(); await buyLifetime();
    const before = { u: await user(), bal: (await ledgerBalance(d, "u")).total };
    expect(await renewal()).toBe("applied");
    const after = await user();
    expect(after.plan).toBe("LIFETIME");
    expect(after.planRenewsAt).toBeNull();
    expect(after.planStatus).toBe(before.u.planStatus);
    expect((await ledgerBalance(d, "u")).total).toBe(before.bal); // no monthly reset, no grant
  });

  it("records the charge for a refund, tells the user, and stops the subscription again", async () => {
    await subscribe(); await buyLifetime();
    h.cancel.mockClear();
    const proNotices = async () => (await d.select().from(notifications).where(eq(notifications.userId, "u"))).filter((n) => /You're on PRO/.test(n.body)).length;
    const noticesBefore = await proNotices();
    await renewal();
    const row = (await d.select().from(payments).where(eq(payments.reference, "renew1")))[0];
    expect(row.status).toBe("success"); // it did happen; the money is on record
    const flagged = await audit("payment.after_lifetime");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].meta).toMatchObject({ reference: "renew1", product: "PRO_MONTHLY", amountMinor: 1500000, currency: "NGN" });
    expect(h.cancel).toHaveBeenCalledWith("SUB_1", "secret-email-token");
    const notes = await d.select().from(notifications).where(eq(notifications.userId, "u"));
    expect(notes.some((n) => /lifetime/i.test(n.body) && /refund|support/i.test(n.body))).toBe(true);
    expect(await proNotices()).toBe(noticesBefore); // the usual "plan updated: you're on PRO" message would be wrong here
  });

  it("also stops a subscription that came with the charge and is not stored yet", async () => {
    await buyLifetime();
    expect(await fulfilPayment(pay({ eventId: "late", reference: "late1", sub: { id: "SUB_NEW", emailToken: "tok-new" } }), d)).toBe("applied");
    expect(h.cancel).toHaveBeenCalledWith("SUB_NEW", "tok-new");
    expect((await user()).plan).toBe("LIFETIME");
    expect(await d.select().from(subscriptions)).toHaveLength(0); // not stored as an active subscription
  });

  it("is idempotent: the same charge delivered again changes nothing more", async () => {
    await subscribe(); await buyLifetime();
    await renewal(); await renewal();
    expect(await audit("payment.after_lifetime")).toHaveLength(1);
  });
});

describe("regressions: ordinary subscription behaviour is unchanged", () => {
  it("a renewal for a Pro user still extends Pro and resets the monthly allowance", async () => {
    await subscribe();
    expect(await renewal()).toBe("applied");
    const u = await user();
    expect(u.plan).toBe("PRO");
    expect(u.planRenewsAt).not.toBeNull();
    expect(await audit("payment.after_lifetime")).toHaveLength(0);
    expect(h.cancel).not.toHaveBeenCalled();
  });
  it("a Pro purchase by a FREE user still works and never touches the provider", async () => {
    await subscribe();
    expect((await user()).plan).toBe("PRO");
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
