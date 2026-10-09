import { and, eq, lt, sql } from "drizzle-orm";
import { auditLog, payments, subscriptions, users, webhookEvents } from "@/db/schema";
import { db, type DB } from "@/lib/db";
import { grantCredits, resetMonthly } from "@/lib/credits";
import { notify, userEmailIfEnabled } from "@/lib/notifications";
import { sendEmail, esc } from "@/lib/email";
import { PRODUCTS, type ProductId } from "@/lib/plans";

export interface FulfilInput {
  provider: "paystack" | "nowpayments";
  eventId: string;
  eventType: string;
  payload: unknown;
  reference: string;
  userId: string;
  product: ProductId;
  amountMinor: number;
  currency: string;
  sub?: { id: string; emailToken?: string; periodEnd?: Date };
}
export type FulfilResult = "applied" | "duplicate" | "already_paid";

const DAY = 86_400_000;
const period = (d = new Date()) => d.toISOString().slice(0, 7);

/**
 * One DB transaction: webhook_events (unique → duplicate is a no-op) → payment upsert (only the
 * transition to success proceeds) → plan/subscription → credit grant → notification → audit_log.
 */
export async function fulfilPayment(i: FulfilInput, d: DB = db()): Promise<FulfilResult> {
  const p = PRODUCTS[i.product];
  const result = await d.transaction(async (tx): Promise<FulfilResult> => {
    const ev = await tx.insert(webhookEvents)
      .values({ provider: i.provider, eventId: i.eventId, type: i.eventType, payload: i.payload as object })
      .onConflictDoNothing().returning({ id: webhookEvents.id });
    if (!ev.length) return "duplicate";

    const transitioned = await tx.insert(payments)
      .values({ userId: i.userId, provider: i.provider, reference: i.reference, kind: p.kind, product: i.product, amountMinor: i.amountMinor, currency: i.currency, status: "success", raw: i.payload as object })
      .onConflictDoUpdate({
        target: payments.reference,
        set: { status: "success", amountMinor: i.amountMinor, currency: i.currency, raw: i.payload as object },
        setWhere: sql`${payments.status} <> 'success'`,
      })
      .returning({ id: payments.id });
    if (!transitioned.length) return "already_paid";

    const now = new Date();
    if (p.kind === "topup") {
      await grantCredits(tx, i.userId, p.credits, "purchased", "topup_purchase", { type: "payment", id: i.reference });
    } else if (p.kind === "lifetime") {
      await tx.update(users).set({ plan: "LIFETIME", planStatus: "active", planRenewsAt: null }).where(eq(users.id, i.userId));
      await tx.update(subscriptions).set({ status: "cancelled" }).where(and(eq(subscriptions.userId, i.userId), eq(subscriptions.status, "active")));
      await resetMonthly(tx, i.userId, p.credits, `pay:${i.reference}`);
    } else {
      const end = i.sub?.periodEnd ?? new Date(now.getTime() + (p.periodDays ?? 31) * DAY);
      await tx.update(users).set({ plan: p.plan!, planStatus: "active", planRenewsAt: end }).where(eq(users.id, i.userId));
      if (i.sub) {
        await tx.insert(subscriptions)
          .values({ userId: i.userId, provider: i.provider, providerSubId: i.sub.id, emailToken: i.sub.emailToken, plan: p.plan!, status: "active", currentPeriodEnd: end })
          .onConflictDoUpdate({ target: [subscriptions.provider, subscriptions.providerSubId], set: { status: "active", currentPeriodEnd: end, cancelAt: null } });
      }
      await resetMonthly(tx, i.userId, p.credits, `pay:${i.reference}`);
    }
    await notify(tx, i.userId, "payment_success", "Payment received", `${p.label} is active. Thanks!`);
    if (p.kind !== "topup") await notify(tx, i.userId, "plan_change", "Plan updated", `You're on ${p.plan}.`);
    await tx.insert(auditLog).values({ actorId: "system", action: "payment.fulfilled", target: i.userId, meta: { reference: i.reference, product: i.product, provider: i.provider } });
    return "applied";
  });

  if (result === "applied") {
    const to = await userEmailIfEnabled(d, i.userId);
    if (to) await sendEmail(to, "Your AltrCam receipt", `<p>Thanks for your payment.</p><p><b>${esc(p.label)}</b><br/>Reference: ${esc(i.reference)}<br/>Amount: ${(i.amountMinor / 100).toFixed(2)} ${esc(i.currency)}</p>`);
  }
  return result;
}

/** Record a webhook that failed verification of amount/product: logged, never granted. */
export async function recordRejected(i: Omit<FulfilInput, "sub">, why: string, d: DB = db()) {
  await d.transaction(async (tx) => {
    const ev = await tx.insert(webhookEvents).values({ provider: i.provider, eventId: i.eventId, type: i.eventType, payload: { why, payload: i.payload } as object }).onConflictDoNothing().returning({ id: webhookEvents.id });
    if (!ev.length) return;
    await tx.insert(payments)
      .values({ userId: i.userId, provider: i.provider, reference: i.reference, kind: PRODUCTS[i.product].kind, product: i.product, amountMinor: i.amountMinor, currency: i.currency, status: "rejected", raw: { why } })
      .onConflictDoUpdate({ target: payments.reference, set: { status: "rejected", raw: { why } }, setWhere: sql`${payments.status} <> 'success'` });
    await tx.insert(auditLog).values({ actorId: "system", action: "payment.rejected", target: i.userId, meta: { reference: i.reference, why } });
  });
}

/** Non-payment events (subscription lifecycle, failed charges): idempotent via webhook_events. */
export async function recordEvent(provider: string, eventId: string, type: string, payload: unknown, apply: (tx: Parameters<Parameters<DB["transaction"]>[0]>[0]) => Promise<void>, d: DB = db()) {
  return d.transaction(async (tx) => {
    const ev = await tx.insert(webhookEvents).values({ provider, eventId, type, payload: payload as object }).onConflictDoNothing().returning({ id: webhookEvents.id });
    if (!ev.length) return false;
    await apply(tx);
    return true;
  });
}

/** Lapsed paid plans → FREE. Purchased credits are kept. LIFETIME is never touched. */
export async function downgradeExpired(d: DB = db(), now = new Date()) {
  const grace = new Date(now.getTime() - 2 * DAY);
  const rows = await d.update(users).set({ plan: "FREE", planStatus: "expired", planRenewsAt: null })
    .where(and(eq(users.plan, "PRO"), lt(users.planRenewsAt, grace))).returning({ id: users.id }); // lt() maps the Date through the column; a raw sql`... ${date}` fails on postgres-js
  for (const r of rows) {
    await notify(d, r.id, "plan_change", "Your Pro plan ended", "You're back on Free. Purchased credits are kept.");
    await d.insert(auditLog).values({ actorId: "system", action: "plan.expired", target: r.id });
  }
  return rows.length;
}
export { period };
