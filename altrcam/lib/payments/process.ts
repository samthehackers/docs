import { eq } from "drizzle-orm";
import { payments, subscriptions, users } from "@/db/schema";
import { db } from "@/lib/db";
import { getProvider, type ProviderName } from "@/lib/payments";
import type { VerifiedEvent, VerifiedPayment } from "@/lib/payments/provider";
import { fulfilPayment, recordEvent, recordRejected } from "@/lib/payments/fulfil";
import { isProductId, listPrice, PRODUCTS, type ProductId } from "@/lib/plans";
import { notify } from "@/lib/notifications";

/**
 * What a payment must amount to: the pending row pinned at checkout (exact amount and currency, any discount included),
 * or for a Paystack renewal (no pending row) the configured NGN list price of the plan.
 */
function expected(row: { amountMinor: number; currency: string } | undefined, product: ProductId) {
  if (row) return { amountMinor: row.amountMinor, currency: row.currency };
  const amountMinor = listPrice(product, "NGN");
  if (amountMinor === null) throw new Error(`No NGN price configured for ${product}; cannot verify this payment`); // 500: the provider retries
  return { amountMinor, currency: "NGN" };
}

/** Resolve who paid and for what. Our own pending row is authoritative; metadata/plan-code cover Paystack renewals. */
async function resolve(v: VerifiedPayment) {
  const d = db();
  const [row] = await d.select().from(payments).where(eq(payments.reference, v.reference));
  let userId = row?.userId ?? v.metadata.userId ?? null;
  let product: string | undefined = row?.product ?? v.metadata.product;
  if (!product && v.planCode) {
    if (v.planCode === process.env.PAYSTACK_PLAN_PRO_MONTHLY) product = "PRO_MONTHLY";
    if (v.planCode === process.env.PAYSTACK_PLAN_PRO_YEARLY) product = "PRO_YEARLY";
  }
  if (!userId && v.customerEmail) {
    const [u] = await d.select({ id: users.id }).from(users).where(eq(users.email, v.customerEmail));
    userId = u?.id ?? null;
  }
  return { row, userId, product: product && isProductId(product) ? (product as ProductId) : null };
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

async function handlePaystack(ev: VerifiedEvent) {
  const data = ev.payload.data ?? {};
  const base = { provider: "paystack" as const, eventId: ev.eventId, eventType: ev.type, payload: ev.payload };
  switch (ev.type) {
    case "charge.success": {
      if (!ev.reference) return;
      const v = await getProvider("paystack").verifyTransaction(ev.reference);
      if (v.status !== "success") return;
      const { row, userId, product } = await resolve(v);
      if (!userId || !product) {
        await recordEvent("paystack", ev.eventId, ev.type, { ...ev.payload, unresolved: true }, async () => {});
        return;
      }
      const exp = expected(row, product);
      const input = { ...base, reference: v.reference, userId, product, amountMinor: v.amountMinor, currency: v.currency };
      if (v.amountMinor !== exp.amountMinor || v.currency !== exp.currency) return recordRejected(input, "amount/currency mismatch");
      // Subscription details (code/token) arrive on subscription.create and are linked there.
      await fulfilPayment(input);
      return;
    }
    case "subscription.create": {
      const email = data.customer?.email as string | undefined;
      const [u] = email ? await db().select({ id: users.id }).from(users).where(eq(users.email, email)) : [];
      if (!u) return;
      const periodEnd = data.next_payment_date ? new Date(data.next_payment_date) : undefined;
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        const plan = "PRO" as const;
        await tx.insert(subscriptions)
          .values({ userId: u.id, provider: "paystack", providerSubId: data.subscription_code, emailToken: data.email_token, plan, status: "active", currentPeriodEnd: periodEnd })
          .onConflictDoUpdate({ target: [subscriptions.provider, subscriptions.providerSubId], set: { emailToken: data.email_token, status: "active", currentPeriodEnd: periodEnd, cancelAt: null } });
      });
      return;
    }
    case "subscription.disable":
    case "subscription.not_renew": {
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        const [s] = await tx.update(subscriptions).set({ status: "cancelled", cancelAt: data.next_payment_date ? new Date(data.next_payment_date) : new Date() })
          .where(eq(subscriptions.providerSubId, data.subscription_code)).returning({ userId: subscriptions.userId });
        // Plan stays until planRenewsAt (period end); the daily cron downgrades it.
        if (s) await notify(tx, s.userId, "plan_change", "Subscription cancelled", "Pro stays active until the end of your paid period.");
      });
      return;
    }
    case "invoice.payment_failed": {
      const email = data.customer?.email as string | undefined;
      const [u] = email ? await db().select({ id: users.id }).from(users).where(eq(users.email, email)) : [];
      if (!u) return;
      await recordEvent("paystack", ev.eventId, ev.type, ev.payload, async (tx) => {
        await tx.update(users).set({ planStatus: "past_due" }).where(eq(users.id, u.id));
        await notify(tx, u.id, "payment_failed", "Renewal payment failed", "Update your card in Billing to keep Pro.");
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
  // Only invoices we created are honoured; the pending row carries user and product.
  if (!row?.userId || !isProductId(row.product)) return;
  const product = row.product as ProductId;
  const userId = row.userId;
  if (PRODUCTS[product].kind === "subscription") return;
  const base = { provider: "nowpayments" as const, eventId: ev.eventId, eventType: ev.type, payload: ev.payload };

  if (ev.type === "partially_paid") {
    await recordEvent("nowpayments", ev.eventId, ev.type, ev.payload, async (tx) => {
      await notify(tx, userId, "payment_partial", "Payment partially received", "Your crypto payment was short. Contact support to complete it.");
    });
    return;
  }
  if (ev.type !== "finished") {
    await recordEvent("nowpayments", ev.eventId, ev.type, ev.payload, async () => {});
    return;
  }
  const v = await getProvider("nowpayments").verifyTransaction(ev.reference, { providerPaymentId: ev.providerPaymentId });
  if (v.status !== "success") return;
  const exp = expected(row, product);
  const input = { ...base, reference: ev.reference, userId, product, amountMinor: v.amountMinor, currency: v.currency };
  if (v.amountMinor !== exp.amountMinor || v.currency !== exp.currency) return recordRejected(input, "amount/currency mismatch");
  await fulfilPayment(input);
}
