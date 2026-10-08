import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { handle, HttpError, parseBody, requireUserId } from "@/lib/api";
import { rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { payments } from "@/db/schema";
import { getUserRow } from "@/lib/users";
import { getProvider } from "@/lib/payments";
import { expectedPrice, PRODUCT_IDS, PRODUCTS } from "@/lib/plans";

const Body = z.object({ product: z.enum(PRODUCT_IDS as [string, ...string[]]), provider: z.enum(["paystack", "nowpayments"]) });

export const POST = handle(async (req: Request) => {
  const userId = await requireUserId();
  await rateLimit("checkout", userId);
  const { product, provider } = await parseBody(req, Body);
  const p = PRODUCTS[product as keyof typeof PRODUCTS];
  const user = await getUserRow(userId);
  if (!user) throw new HttpError(403, "Account not found");
  if (provider === "nowpayments" && p.kind === "subscription") throw new HttpError(400, "Crypto supports Lifetime and top-ups only");
  if (user.plan === "LIFETIME" && p.kind !== "topup") throw new HttpError(400, "You already have Lifetime");

  const price = expectedPrice(p.id);
  const reference = `alt_${randomUUID().replace(/-/g, "")}`;
  // Pending row first: it pins user + product + price to the reference for later verification.
  await db().insert(payments).values({ userId, provider, reference, kind: p.kind, product: p.id, amountMinor: price.amountMinor, currency: price.currency, status: "pending" });
  const checkout = await getProvider(provider).createCheckout({ userId, email: user.email, product: p.id, reference, amountMinor: price.amountMinor, currency: price.currency });
  return NextResponse.json({ url: checkout.url, reference });
});
