import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { payments, subscriptions } from "@/db/schema";
import { fmtDate } from "@/lib/account-summary";
import { getUserRow } from "@/lib/users";
import { getProvider } from "@/lib/payments";
import { CURRENCY_FOR_PROVIDER, PRODUCT_IDS, PRODUCTS, type ProductId } from "@/lib/plans";
import { getPlans } from "@/lib/plan-config";
import { quote } from "@/lib/pricing";
import { appUrlUsable, capabilities } from "@/lib/config";

const Body = z.object({ product: z.enum(PRODUCT_IDS as [ProductId, ...ProductId[]]), provider: z.enum(["paystack", "nowpayments"]) });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("checkout", userId);
  const { product, provider } = await parseBody(req, Body);
  if (!capabilities()[provider === "paystack" ? "paystack" : "nowpayments"]) {
    throw new HttpError(503, "Payments aren't available yet. Nothing was charged.", { code: "unavailable" });
  }
  // The providers send the buyer back (and NOWPayments its IPNs) to NEXT_PUBLIC_APP_URL: without a usable one, stop before anything is created.
  if (!appUrlUsable()) throw new HttpError(503, "Payments aren't set up correctly on this deployment yet. Nothing was charged.", { code: "app_url" });
  const p = PRODUCTS[product];
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  if (user.plan === "LIFETIME" && p.kind !== "topup") throw new HttpError(409, "You already have Lifetime. Nothing was charged.", { code: "already_lifetime" });
  if (p.kind === "subscription") {
    // Never a second subscription: it would bill twice. Also while a cancelled one's paid period is still running.
    const [active] = await db().select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"))).limit(1);
    if (active) throw new HttpError(409, "You already have an active Pro subscription, so you can't start another. Nothing was charged.", { code: "already_subscribed" });
    if (user.plan === "PRO" && user.planRenewsAt && user.planRenewsAt.getTime() > Date.now()) {
      throw new HttpError(409, `Your Pro plan is already paid until ${fmtDate(user.planRenewsAt)}. You can subscribe again after that date. Nothing was charged.`, { code: "already_subscribed" });
    }
  }

  // The same answer the pricing and billing pages use: a product that is not on sale is refused here too.
  const q = quote(product, CURRENCY_FOR_PROVIDER[provider], { plans: await getPlans(), buyerPlan: user.plan });
  if (!q.ok) throw new HttpError(q.reason === "crypto_subscription" ? 400 : 409, q.message, { code: q.reason });
  const { amountMinor, currency } = q.offer;

  const reference = `alt_${randomUUID().replace(/-/g, "")}`;
  // Pending row first: it pins user + product + exact amount + currency to the reference. Webhooks verify against this row.
  await db().insert(payments).values({ userId, provider, reference, kind: p.kind, product, amountMinor, currency, status: "pending" });
  let url: string;
  try {
    url = (await getProvider(provider).createCheckout({ userId, email: user.email, product, reference, amountMinor, currency })).url;
    if (!url) throw new Error("provider returned no checkout URL");
  } catch (e) {
    // Nothing reached the buyer, so nothing can have been paid: close the row instead of leaving it "pending".
    console.error(`[checkout] ${provider} createCheckout failed for ${reference}:`, e instanceof Error ? e.message : e);
    await db().update(payments).set({ status: "failed", raw: { why: "checkout start failed" } }).where(and(eq(payments.reference, reference), eq(payments.status, "pending")));
    throw new HttpError(502, "Couldn't reach the payment provider. Nothing was charged.", { code: "provider_unreachable" });
  }
  return NextResponse.json({ url, reference });
});
