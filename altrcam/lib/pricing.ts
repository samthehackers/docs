import { PRODUCTS, type ProductId } from "@/lib/plans";
import { money } from "@/lib/utils";

/** Display price; never throws so public pages render even with partial env. "TBA" until a price is configured. */
export function priceLabel(p: ProductId): string {
  const v = Number(process.env[PRODUCTS[p].priceEnv]);
  if (!Number.isFinite(v) || v <= 0) return "TBA";
  return money(v, process.env.PRICE_CURRENCY ?? "NGN");
}

/** Prices are owner-configurable placeholders until PRICING_APPROVED=true. */
export const pricesApproved = () => process.env.PRICING_APPROVED === "true";
