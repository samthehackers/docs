import {
  buyerPrice, LIFETIME_TOPUP_DISCOUNT, listPrice, PROVIDER_FOR_CURRENCY, providerSells,
  type Currency, type EnvSource, type PayProvider, type Plan, type PlanConfig, type ProductId,
} from "@/lib/plans";
import { checkMargin, marginInputs } from "@/lib/margin";
import { money } from "@/lib/utils";

/**
 * What is on sale, at what price, through which provider. The pricing page, the billing page and the checkout API all ask
 * `quote()`, so a product that is not offered is hidden on both pages AND refused at checkout: they cannot disagree.
 */
export interface Offer {
  product: ProductId;
  currency: Currency;
  provider: PayProvider;
  /** What this buyer is charged, minor units. Pinned in the pending payment row at checkout. */
  amountMinor: number;
  /** The configured list price, minor units. */
  listMinor: number;
}

export type NotOfferedReason = "crypto_subscription" | "no_price" | "margin_unproven" | "margin_fails";
export type Quote = { ok: true; offer: Offer } | { ok: false; reason: NotOfferedReason; message: string };

export interface QuoteContext {
  /** Effective plan limits (admin overrides included). */
  plans: Record<Plan, PlanConfig>;
  /** The buyer's current plan, when known. */
  buyerPlan?: Plan | null;
  env?: EnvSource;
}

const MESSAGES: Record<NotOfferedReason, string> = {
  crypto_subscription: "Crypto can't pay for a subscription. Pay for Pro by card. Nothing was charged.",
  no_price: "This isn't on sale right now. Nothing was charged.",
  margin_unproven: "This isn't on sale right now. Nothing was charged.",
  margin_fails: "This isn't on sale right now. Nothing was charged.",
};

/**
 * Is it on sale, and at what price? Not on sale when: crypto is asked to sell a subscription; there is no price in that currency;
 * or the margin guard (lib/margin.ts) can't prove, or fails, MIN_MARGIN at full usage FOR THE PRICE THIS BUYER WOULD PAY
 * (so a discounted top-up is checked at its discounted price). Buyers only ever see "not on sale"; the reason is for logs.
 */
export function quote(product: ProductId, currency: Currency, ctx: QuoteContext): Quote {
  const env = ctx.env ?? process.env;
  const provider = PROVIDER_FOR_CURRENCY[currency];
  const no = (reason: NotOfferedReason): Quote => ({ ok: false, reason, message: MESSAGES[reason] });
  if (!providerSells(provider, product)) return no("crypto_subscription");
  const listMinor = listPrice(product, currency, env);
  const amountMinor = buyerPrice(product, currency, ctx.buyerPlan, env);
  if (listMinor === null || amountMinor === null) return no("no_price");
  const m = checkMargin(product, currency, amountMinor, ctx.plans, marginInputs(env));
  if (m.status !== "pass") return no(m.status === "fail" ? "margin_fails" : "margin_unproven");
  return { ok: true, offer: { product, currency, provider, amountMinor, listMinor } };
}

/** The offer, or null when the product is not on sale in that currency (hide it). */
export function offer(product: ProductId, currency: Currency, ctx: QuoteContext): Offer | null {
  const q = quote(product, currency, ctx);
  return q.ok ? q.offer : null;
}

/** "₦15,000", "$9.99". */
export const offerPrice = (o: Offer) => money(o.amountMinor, o.currency);

/** "20% Lifetime discount (list price NGN 3,000)" when this offer is discounted, else undefined. */
export const discountNote = (o: Offer) =>
  o.amountMinor < o.listMinor ? `${Math.round(LIFETIME_TOPUP_DISCOUNT * 100)}% Lifetime discount (list price ${money(o.listMinor, o.currency)})` : undefined;

/** Which providers are configured on this deployment (from lib/config capabilities). */
export interface ProvidersOpen { paystack: boolean; nowpayments: boolean }

/** Every way this product can be bought right now: card (NGN) first, then crypto (USD). Empty = not on sale. */
export function offersFor(product: ProductId, ctx: QuoteContext, open: ProvidersOpen): Offer[] {
  return (["NGN", "USD"] as const).flatMap((c) => {
    const o = offer(product, c, ctx);
    return o && open[o.provider] ? [o] : [];
  });
}

/** Button text for one way to pay: "Card · ₦15,000" or "Crypto · $10". */
export const payLabel = (o: Offer) => `${o.provider === "paystack" ? "Card" : "Crypto"} · ${offerPrice(o)}`;

/** Prices are owner-configurable placeholders until PRICING_APPROVED=true. */
export const pricesApproved = () => process.env.PRICING_APPROVED === "true";
