import { PRODUCTS, type ProductId } from "@/lib/plans";
import { money } from "@/lib/utils";

/** The currency every price is shown and charged in (one for the whole deployment). */
export const priceCurrency = () => process.env.PRICE_CURRENCY ?? "NGN";

/** Display price; never throws so public pages render even with partial env. "TBA" until a price is configured. */
export function priceLabel(p: ProductId): string {
  const v = Number(process.env[PRODUCTS[p].priceEnv]);
  if (!Number.isFinite(v) || v <= 0) return "TBA";
  return money(v, priceCurrency());
}

/** Prices are owner-configurable placeholders until PRICING_APPROVED=true. */
export const pricesApproved = () => process.env.PRICING_APPROVED === "true";
