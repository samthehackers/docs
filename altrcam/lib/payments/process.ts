import { and, desc, eq, ne, sql } from "drizzle-orm";
import { auditLog, payments, subscriptions, users } from "@/db/schema";
import { db } from "@/lib/db";
import { getProvider, type ProviderName } from "@/lib/payments";
import type { VerifiedEvent, VerifiedPayment } from "@/lib/payments/provider";
import { fulfilPayment, recordEvent, recordRejected } from "@/lib/payments/fulfil";
import { isProductId, listPrice, PRODUCTS, type ProductId } from "@/lib/plans";
import { notify } from "@/lib/notifications";

type PaymentRow = typeof payments.$inferSelect;

/** Which of our products a Paystack plan code is (only the two Pro plans), or null. */
export function productForPlanCode(planCode: string | undefined): ProductId | null {
  if (!planCode) return null;
  if (planCode === process.env.PAYSTACK_PLAN_PRO_MONTHLY) return "PRO_MONTHLY";
  if (planCode === process.env.PAYSTACK_PLAN_PRO_YEARLY) return "PRO_YEARLY";
  return null;
}

/**
 * Why a verified payment does not match the pending row written at checkout, or null when it matches. The row pinned the
 * provider, user, product, exact amount and currency (any Lifetime discount included), so the comparison is against the row,
 * never against today's price list. Provider metadata, when present, must agree with the row too.
 */
export function pendingMismatch(row: Pick<PaymentRow, "provider" | "userId" | "product" | "amountMinor" | "currency">, provider: ProviderName, v: VerifiedPayment): string | null {
  if (row.provider !== provider) return `provider mismatch: checkout was ${row.provider}, payment came from ${provider}`;
  if (v.metadata.userId && v.metadata.userId !== row.userId) return "user mismatch";
  if (v.metadata.product && v.metadata.product !== row.product) return `product mismatch: checkout was ${row.product}, payment says ${v.metadata.product}`;
  const planProduct = productForPlanCode(v.planCode);
  if (v.planCode && planProduct !== null && planProduct !== row.product) return `product mismatch: checkout was ${row.product}, plan is ${planProduct}`;
  if (v.currency !== row.currency) return `currency mismatch: expected ${row.currency}, paid ${v.currency}`;
  if (v.amountMinor !== row.amountMinor) return `amount mismatch: expected ${row.amountMinor}, paid ${v.amountMinor}`;
  return null;
}

/**
 * Who a Paystack customer is, for events with no pending row of ours (renewals, subscription lifecycle, failed invoices). Users can
 * change their email, so stable Paystack codes come first: the subscription code, then the customer code (stored on our
 * subscription row at subscription.create, or seen on an earlier successful charge of theirs), and the email only last.
 */
async function paystackUser(c: { subscriptionCode?: string; customerCode?: string; email?: string }): Promise<string | null> {
  const d = db();
  if (c.subscriptionCode) {
    const [s] = await d.select({ userId: subscriptions.userId }).from(subscriptions)
      .where(and(eq(subscriptions.provider, "paystack"), eq(subscriptions.providerSubId, c.subscriptionCode)));
    if (s) return s.userId;
  }
  if (c.customerCode) {
    const [s] = await d.select({ userId: subscriptions.userId }).from(subscriptions)
      .where(and(eq(subscriptions.provider, "paystack"), eq(subscriptions.customerCode, c.customerCode))).orderBy(desc(subscriptions.id)).limit(1);
    if (s) return s.userId;
    const [p] = await d.select({ userId: payments.userId }).from(payments)
      .where(and(eq(payments.provider, "paystack"), eq(payments.status, "success"), sql`${payments.raw}->'data'->'customer'->>'customer_code' = ${c.customerCode}`))
      .orderBy(desc(payments.id)).limit(1);
    if (p?.userId) return p.userId;
  }
  if (c.email) {
    const [u] = await d.select({ id: users.id }).from(users).where(eq(users.email, c.email));
    if (u) return u.id;
  }
  return null;
}

/** A payment for a reference whose account was deleted (the row is anonymised): never granted, left for a manual refund. */
async function recordOrphan(provider: ProviderName, ev: VerifiedEvent, reference: string, v: VerifiedPayment) {
  await recordEvent(provider, ev.eventId, ev.type, { ...ev.payload, unresolved: true }, async (tx) => {
    await tx.insert(auditLog).values({ actorId: "system", action: "payment.account_deleted", target: null, meta: { reference, provider, amountMinor: v.amountMinor, currency: v.currency } });
  });
}

export async function processWebhook(name: ProviderName, req: Request): Promise<{ status: number; body: string }> {
  const provider = getProvider(name);
  const ev = await provider.verifyWebhook(req);
  if (!ev) return { status: 401, body: "invalid signature" };
  try {
    if (name === "paystack") await handlePaystack(ev);
    else await handleNowpayments(ev);
  } catch (e) {
    console.error(`[webhook:${name}]`, e);
    return { status: 500, body: "error" }; // provider retries; idempotency makes retries safe
  }
  return { status: 200, body: "ok" };
}

async function paystackCharge(ev: VerifiedEvent) {
  if (!ev.reference) return;
  const v = await getProvider("paystack").verifyTransaction(ev.reference); // server to server: the webhook body is never trusted
  if (v.status !== "success") return;
  const base = { provider: "paystack" as const, eventId: ev.eventId, eventType: ev.type, payload: ev.payload, reference: v.reference, amountMinor: v.amountMinor, currency: v.currency };
  const [row] = await db().select().from(payments).where(eq(payments.reference, v.reference));

  if (row) {
    // Our own checkout: the pending row is authoritative.
    if (!isProductId(row.product)) throw new Error(`payment ${row.reference} has an unknown product ${row.product}`);
    if (!row.userId) return recordOrphan("paystack", ev, v.reference, v);
    const input = { ...base, userId: row.userId, product: row.product as ProductId };
    const why = pendingMismatch(row, "paystack", v);
    if (why) return recordRejected(input, why);
    return void (await fulfilPayment(input)); // subscription code/token arrive on subscription.create and are linked there
  }

  // No pending row: a renewal Paystack charged on its own schedule. Only our Pro plans qualify, at the configured NGN price.
  const product = productForPlanCode(v.planCode);
  const userId = product ? await paystackUser({ customerCode: v.customerCode, email: v.customerEmail }) : null;
  if (!product || !userId) {
    await recordEvent("paystack", ev.eventId, ev.type, { ...ev.payload, unresolved: true }, async () => {});
    return;
  }
  const amountMinor = listPrice(product, "NGN");
  if (amountMinor === null) throw new Error(`No NGN price configured for ${product}; cannot verify renewal ${v.reference}`); // 500: Paystack retries
  const input = { ...base, userId, product };
  if (v.currency !== "NGN") return recordRejected(input, `currency mismatch: expected NGN, paid ${v.currency}`);
  if (v.amountMinor !== amountMinor) return recordRejected(input, `amount mismatch: expected ${amountMinor}, paid ${v.amountMinor}`);
  await fulfilPayment(input);
}

async function handlePaystack(ev: VerifiedEvent) {
  const data = ev.payload.data ?? {};
  switch (ev.type) {
    case "charge.success":
      return paystackCharge(ev);
    case "subscription.create": {
      const code = data.subscription_code as string | undefined;
      const customerCode = data.customer?.customer_code as string | undefined;
      const userId = code ? await paystackUser({ subscriptionCode: code, customerCode, email: data.customer?.email }) : null;
      if (!code || !userId) {
        await recordEvent("paystack", ev.eventId, ev.type, { ...ev.payload, unresolved: true }, async () => {});
        return;
      }
      const periodEnd = data.next_payment_date ? new Date(data.next_payment_date) : undefined;
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        await tx.insert(subscriptions)
          .values({ userId, provider: "paystack", providerSubId: code, customerCode, emailToken: data.email_token, plan: "PRO", status: "active", currentPeriodEnd: periodEnd })
          .onConflictDoUpdate({ target: [subscriptions.provider, subscriptions.providerSubId], set: { customerCode, emailToken: data.email_token, status: "active", currentPeriodEnd: periodEnd, cancelAt: null } });
        // Checkout refuses a second subscription, but two checkouts started side by side can both be paid. Flag it for a person.
        const others = await tx.select({ code: subscriptions.providerSubId }).from(subscriptions)
          .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"), ne(subscriptions.providerSubId, code)));
        if (others.length) {
          await tx.insert(auditLog).values({ actorId: "system", action: "subscription.duplicate", target: userId, meta: { subscription: code, alsoActive: others.map((o) => o.code) } });
          await notify(tx, userId, "plan_change", "You have two Pro subscriptions", "Two Pro subscriptions are active on your account. Contact support and we will cancel one and refund it.");
        }
      });
      return;
    }
    case "subscription.disable":
    case "subscription.not_renew": {
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        const [s] = await tx.update(subscriptions).set({ status: "cancelled", cancelAt: data.next_payment_date ? new Date(data.next_payment_date) : new Date() })
          .where(and(eq(subscriptions.provider, "paystack"), eq(subscriptions.providerSubId, data.subscription_code))).returning({ userId: subscriptions.userId });
        // Plan stays until planRenewsAt (period end); the daily cron downgrades it.
        if (s) await notify(tx, s.userId, "plan_change", "Subscription cancelled", "Pro stays active until the end of your paid period.");
      });
      return;
    }
    case "invoice.payment_failed": {
      const userId = await paystackUser({ subscriptionCode: data.subscription?.subscription_code, customerCode: data.customer?.customer_code, email: data.customer?.email });
      if (!userId) {
        await recordEvent("paystack", ev.eventId, ev.type, { ...ev.payload, unresolved: true }, async () => {});
        return;
      }
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        await tx.update(users).set({ planStatus: "past_due" }).where(and(eq(users.id, userId), eq(users.plan, "PRO")));
        await notify(tx, userId, "payment_failed", "Renewal payment failed",
          "Paystack couldn't charge your card for Pro. If Paystack emailed you a link to update your card, use it; otherwise contact support. This site can't change your card.");
      });
      return;
    }
    default:
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async () => {});
  }
}

async function handleNowpayments(ev: VerifiedEvent) {
  if (!ev.reference) return;
  const d = db();
  const [row] = await d.select().from(payments).where(eq(payments.reference, ev.reference));
  // Only invoices we created are honoured; the pending row carries user, product, amount and currency.
  if (!row || row.provider !== "nowpayments" || !isProductId(row.product)) return;
  const product = row.product as ProductId;
  if (PRODUCTS[product].kind === "subscription") return;
  const base = { provider: "nowpayments" as const, eventId: ev.eventId, eventType: ev.type, payload: ev.payload };

  if (ev.type === "partially_paid") {
    // Short payment: never grants anything; the person is told and support completes or refunds it by hand.
    await recordEvent("nowpayments", ev.eventId, ev.type, ev.payload, async (tx) => {
      if (row.userId) await notify(tx, row.userId, "payment_partial", "Payment partially received", "Your crypto payment was short. Contact support to complete it.");
    });
    return;
  }
  if (ev.type !== "finished") {
    await recordEvent("nowpayments", ev.eventId, ev.type, ev.payload, async (tx) => {
      if (["failed", "expired"].includes(ev.type)) {
        await tx.update(payments).set({ status: "failed" }).where(and(eq(payments.reference, row.reference), eq(payments.status, "pending")));
      }
    });
    return;
  }
  const v = await getProvider("nowpayments").verifyTransaction(ev.reference, { providerPaymentId: ev.providerPaymentId });
  if (v.status !== "success") return;
  if (!row.userId) return recordOrphan("nowpayments", ev, ev.reference, v);
  const input = { ...base, reference: ev.reference, userId: row.userId, product, amountMinor: v.amountMinor, currency: v.currency };
  const why = pendingMismatch(row, "nowpayments", v);
  if (why) return recordRejected(input, why);
  await fulfilPayment(input);
}
