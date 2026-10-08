import { PRODUCTS, type ProductId } from "@/lib/plans";
import { money } from "@/lib/utils";

/** Display price; never throws so public pages render even with partial env. */
export function priceLabel(p: ProductId): string {
  const v = Number(process.env[PRODUCTS[p].priceEnv]);
  if (!Number.isFinite(v) || v <= 0) return "—";
  return money(v, process.env.PRICE_CURRENCY ?? "NGN");
}
