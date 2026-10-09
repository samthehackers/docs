import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { payments } from "@/db/schema";
import { getUserRow } from "@/lib/users";
import { getProvider } from "@/lib/payments";
import { CURRENCY_FOR_PROVIDER, PRODUCT_IDS, PRODUCTS, type ProductId } from "@/lib/plans";
import { getPlans } from "@/lib/plan-config";
import { quote } from "@/lib/pricing";
import { capabilities } from "@/lib/config";

const Body = z.object({ product: z.enum(PRODUCT_IDS as [ProductId, ...ProductId[]]), provider: z.enum(["paystack", "nowpayments"]) });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("checkout", userId);
  const { product, provider } = await parseBody(req, Body);
  if (!capabilities()[provider === "paystack" ? "paystack" : "nowpayments"]) {
    throw new HttpError(503, "Payments aren't available yet. Nothing was charged.", { code: "unavailable" });
  }
  const p = PRODUCTS[product];
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  if (user.plan === "LIFETIME" && p.kind !== "topup") throw new HttpError(409, "You already have Lifetime. Nothing was charged.", { code: "already_lifetime" });

  // The same answer the pricing and billing pages use: a product that is not on sale is refused here too.
  const q = quote(product, CURRENCY_FOR_PROVIDER[provider], { plans: await getPlans(), buyerPlan: user.plan });
  if (!q.ok) throw new HttpError(q.reason === "crypto_subscription" ? 400 : 409, q.message, { code: q.reason });
  const { amountMinor, currency } = q.offer;

  const reference = `alt_${randomUUID().replace(/-/g, "")}`;
  // Pending row first: it pins user + product + exact amount + currency to the reference. Webhooks verify against this row.
  await db().insert(payments).values({ userId, provider, reference, kind: p.kind, product, amountMinor, currency, status: "pending" });
  const checkout = await getProvider(provider).createCheckout({ userId, email: user.email, product, reference, amountMinor, currency });
  return NextResponse.json({ url: checkout.url, reference });
});
