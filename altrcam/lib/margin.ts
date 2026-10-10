/**
 * Margin guard: the site must never sell something that loses money if the buyer uses every credit it grants.
 *
 *   1 credit = 1 second of model time, costing FAL_COST_PER_SECOND_USD.
 *   gross margin = (revenue in USD - cost of full usage in USD) / revenue in USD, NGN converted with FX_NGN_PER_USD.
 *   A product passes when margin >= MIN_MARGIN (default 0.5).
 *
 * Full usage per paid product: Pro monthly = one month's allowance; Pro yearly = 12 months; Lifetime = LIFETIME_MARGIN_MONTHS
 * months of its monthly allowance; a top-up = its credits. Allowances are the EFFECTIVE plan limits (admin overrides included),
 * so raising an allowance in Admin → Plans can take a product off sale. Payment-provider fees and the cost of free users are
 * not included. Pure functions only: lib/pricing.ts applies the verdict (hidden + refused at checkout); scripts/preflight.ts prints it.
 */
import {
  buyerPrice, CURRENCIES, listPrice, MAX_PRICE_MINOR, PRODUCT_IDS, PRODUCTS, PROVIDER_FOR_CURRENCY, providerSells,
  type Currency, type EnvSource, type Plan, type PlanConfig, type ProductId,
} from "@/lib/plans";

/** How many months of full use a Lifetime purchase must pay for. */
export const LIFETIME_MARGIN_MONTHS = 36;
export const DEFAULT_MIN_MARGIN = 0.5;

export interface MarginInputs {
  /** USD per second of model time; null when unset or not a positive number. */
  costPerSecondUsd: number | null;
  /** Naira per US dollar; null when unset or not a positive number. */
  fxNgnPerUsd: number | null;
  /** 0 <= m < 1; null when MIN_MARGIN is set to something invalid (then nothing can be proven). */
  minMargin: number | null;
}

const positive = (v: string | undefined) => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function marginInputs(env: EnvSource = process.env): MarginInputs {
  const raw = env.MIN_MARGIN;
  let minMargin: number | null = DEFAULT_MIN_MARGIN;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    minMargin = Number.isFinite(n) && n >= 0 && n < 1 ? n : null;
  }
  return { costPerSecondUsd: positive(env.FAL_COST_PER_SECOND_USD), fxNgnPerUsd: positive(env.FX_NGN_PER_USD), minMargin };
}

/** Credits (= seconds of model time) a product hands out if the buyer uses all of them. */
export function fullUsageCredits(product: ProductId, plans: Record<Plan, PlanConfig>): number {
  switch (product) {
    case "PRO_MONTHLY": return plans.PRO.monthlyCredits;
    case "PRO_YEARLY": return 12 * plans.PRO.monthlyCredits;
    case "LIFETIME": return LIFETIME_MARGIN_MONTHS * plans.LIFETIME.monthlyCredits;
    default: return PRODUCTS[product].credits;
  }
}

/** Revenue in USD for a price in minor units; null when NGN cannot be converted (no FX). */
export function revenueUsd(priceMinor: number, currency: Currency, fxNgnPerUsd: number | null): number | null {
  if (currency === "USD") return priceMinor / 100;
  return fxNgnPerUsd ? priceMinor / 100 / fxNgnPerUsd : null;
}

/** Pure gross-margin arithmetic. */
export function grossMargin(revenue: number, costUsd: number): number {
  return (revenue - costUsd) / revenue;
}

export type MarginStatus = "pass" | "fail" | "unproven";
export interface MarginVerdict {
  status: MarginStatus;
  credits: number;
  costUsd: number | null;
  revenueUsd: number | null;
  margin: number | null;
  /** What is missing or wrong, for logs and the preflight table. Never shown to buyers. */
  detail: string;
}

const EPS = 1e-9;

/** Does selling `product` for `priceMinor` (in `currency`) keep at least MIN_MARGIN at full usage? */
export function checkMargin(product: ProductId, currency: Currency, priceMinor: number, plans: Record<Plan, PlanConfig>, inputs: MarginInputs): MarginVerdict {
  const credits = fullUsageCredits(product, plans);
  const base = { credits, costUsd: null, revenueUsd: null, margin: null };
  if (inputs.minMargin === null) return { ...base, status: "unproven", detail: "MIN_MARGIN is not a number from 0 to just under 1" };
  if (inputs.costPerSecondUsd === null) return { ...base, status: "unproven", detail: "FAL_COST_PER_SECOND_USD is not set" };
  const costUsd = credits * inputs.costPerSecondUsd;
  const revenue = revenueUsd(priceMinor, currency, inputs.fxNgnPerUsd);
  if (revenue === null) return { ...base, costUsd, status: "unproven", detail: "FX_NGN_PER_USD is not set, so an NGN price can't be compared with a USD cost" };
  const margin = grossMargin(revenue, costUsd);
  const ok = margin + EPS >= inputs.minMargin;
  return {
    status: ok ? "pass" : "fail", credits, costUsd, revenueUsd: revenue, margin,
    detail: ok ? "" : `margin ${(margin * 100).toFixed(1)}% is below the ${(inputs.minMargin * 100).toFixed(0)}% minimum`,
  };
}

/** The lowest price (minor units, rounded up) that passes, or null when it cannot be computed. */
export function minPassingPriceMinor(product: ProductId, currency: Currency, plans: Record<Plan, PlanConfig>, inputs: MarginInputs): number | null {
  if (inputs.minMargin === null || inputs.costPerSecondUsd === null) return null;
  if (currency === "NGN" && inputs.fxNgnPerUsd === null) return null;
  const minRevenueUsd = (fullUsageCredits(product, plans) * inputs.costPerSecondUsd) / (1 - inputs.minMargin);
  const perUsd = currency === "USD" ? 1 : inputs.fxNgnPerUsd!;
  return Math.max(1, Math.ceil(minRevenueUsd * perUsd * 100 - EPS));
}

export type BuyerKind = "everyone" | "lifetime member";
export interface MarginRow {
  product: ProductId;
  currency: Currency;
  buyer: BuyerKind;
  /** Credits handed out at full usage. */
  credits: number;
  priceMinor: number | null;
  minPriceMinor: number | null;
  verdict: MarginVerdict | null;
  /** "no price" = not on sale in this currency (hidden either way). */
  status: MarginStatus | "no price";
}

/** Every product a provider can sell, in every currency, at the list price (and, for top-ups, at the Lifetime member price). */
export function marginTable(plans: Record<Plan, PlanConfig>, env: EnvSource = process.env): MarginRow[] {
  const inputs = marginInputs(env);
  const rows: MarginRow[] = [];
  for (const product of PRODUCT_IDS) {
    for (const currency of CURRENCIES) {
      if (!providerSells(PROVIDER_FOR_CURRENCY[currency], product)) continue;
      const buyers: BuyerKind[] = PRODUCTS[product].kind === "topup" ? ["everyone", "lifetime member"] : ["everyone"];
      for (const buyer of buyers) {
        const priceMinor = buyer === "everyone" ? listPrice(product, currency, env) : buyerPrice(product, currency, "LIFETIME", env);
        const verdict = priceMinor === null ? null : checkMargin(product, currency, priceMinor, plans, inputs);
        const minList = minPassingPriceMinor(product, currency, plans, inputs);
        rows.push({ product, currency, buyer, credits: fullUsageCredits(product, plans), priceMinor, minPriceMinor: minList, verdict, status: verdict ? verdict.status : "no price" });
      }
    }
  }
  return rows;
}

const fmtMinor = (m: number | null, c: Currency) => (m === null ? "-" : `${c} ${(m / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
const fmtUsd = (n: number | null) => (n === null ? "-" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

/** Plain-text table for the terminal (scripts/preflight.ts). */
export function formatMarginTable(rows: MarginRow[], inputs: MarginInputs): string {
  const head = [
    `Margin guard: cost ${inputs.costPerSecondUsd === null ? "UNSET" : `$${inputs.costPerSecondUsd}/s`} (FAL_COST_PER_SECOND_USD), ` +
    `FX ${inputs.fxNgnPerUsd === null ? "UNSET" : `${inputs.fxNgnPerUsd} NGN/USD`} (FX_NGN_PER_USD), minimum margin ${inputs.minMargin === null ? "INVALID" : `${(inputs.minMargin * 100).toFixed(0)}%`} (MIN_MARGIN).`,
    `Full usage: Pro monthly = 1 month's allowance, Pro yearly = 12, Lifetime = ${LIFETIME_MARGIN_MONTHS} months, top-ups = their credits. Fees and free users not included.`,
  ];
  const cols = ["product", "cur", "buyer", "credits", "cost", "price", "revenue", "margin", "min price", "status"];
  const body = rows.map((r) => [
    r.product, r.currency, r.buyer, r.credits.toLocaleString("en-US"), fmtUsd(inputs.costPerSecondUsd === null ? null : r.credits * inputs.costPerSecondUsd), fmtMinor(r.priceMinor, r.currency),
    fmtUsd(r.verdict?.revenueUsd ?? null), r.verdict?.margin == null ? "-" : `${(r.verdict.margin * 100).toFixed(1)}%`,
    r.buyer !== "everyone" ? "" : r.minPriceMinor !== null && r.minPriceMinor > MAX_PRICE_MINOR ? "too big to store" : fmtMinor(r.minPriceMinor, r.currency),
    r.status === "pass" ? "PASS (on sale)" : r.status === "no price" ? "no price (hidden)" : `${r.status.toUpperCase()} (hidden): ${r.verdict?.detail ?? ""}`,
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells: string[]) => cells.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
  return [...head, "", line(cols), ...body.map(line)].join("\n");
}
