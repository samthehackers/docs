/** Single source of truth for plans, products and limits. 1 credit = 1 second of realtime AI output. */
export type Plan = "FREE" | "PRO" | "LIFETIME";
export type Resolution = "low" | "high";
export type ProductId =
  | "PRO_MONTHLY"
  | "PRO_YEARLY"
  | "LIFETIME"
  | "TOPUP_1K"
  | "TOPUP_5K"
  | "TOPUP_15K";

export interface PlanConfig {
  label: string;
  monthlyCredits: number;
  maxSessionSeconds: number;
  maxResolution: Resolution;
  presets: number;
  /** History retention in days; null = forever. */
  historyDays: number | null;
  clipRecording: boolean;
}

export const PLANS: Record<Plan, PlanConfig> = {
  FREE: { label: "Free", monthlyCredits: 300, maxSessionSeconds: 120, maxResolution: "low", presets: 3, historyDays: 7, clipRecording: false },
  PRO: { label: "Pro", monthlyCredits: 6000, maxSessionSeconds: 1800, maxResolution: "high", presets: 100, historyDays: 365, clipRecording: true },
  LIFETIME: { label: "Lifetime", monthlyCredits: 6000, maxSessionSeconds: 1800, maxResolution: "high", presets: 100, historyDays: null, clipRecording: true },
};

export interface ProductConfig {
  id: ProductId;
  kind: "subscription" | "lifetime" | "topup";
  label: string;
  /** Plan granted (subscription/lifetime). */
  plan?: Plan;
  /** Credits granted immediately on fulfilment (top-ups: purchased bucket). */
  credits: number;
  /** Subscription period length in days. */
  periodDays?: number;
  priceEnv: string;
}

export const PRODUCTS: Record<ProductId, ProductConfig> = {
  PRO_MONTHLY: { id: "PRO_MONTHLY", kind: "subscription", label: "Pro (monthly)", plan: "PRO", credits: PLANS.PRO.monthlyCredits, periodDays: 31, priceEnv: "PRICE_PRO_MONTHLY" },
  PRO_YEARLY: { id: "PRO_YEARLY", kind: "subscription", label: "Pro (yearly)", plan: "PRO", credits: PLANS.PRO.monthlyCredits, periodDays: 366, priceEnv: "PRICE_PRO_YEARLY" },
  LIFETIME: { id: "LIFETIME", kind: "lifetime", label: "Lifetime", plan: "LIFETIME", credits: PLANS.LIFETIME.monthlyCredits, priceEnv: "PRICE_LIFETIME" },
  TOPUP_1K: { id: "TOPUP_1K", kind: "topup", label: "1,000 credits", credits: 1000, priceEnv: "PRICE_TOPUP_1K" },
  TOPUP_5K: { id: "TOPUP_5K", kind: "topup", label: "5,000 credits", credits: 5000, priceEnv: "PRICE_TOPUP_5K" },
  TOPUP_15K: { id: "TOPUP_15K", kind: "topup", label: "15,000 credits", credits: 15000, priceEnv: "PRICE_TOPUP_15K" },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[];

export function isProductId(v: string): v is ProductId {
  return v in PRODUCTS;
}

/** Expected price in minor units, read from env at call time so tests/webhooks always compare against current config. */
export function expectedPrice(product: ProductId): { amountMinor: number; currency: string } {
  const amount = Number(process.env[PRODUCTS[product].priceEnv]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Price not configured for ${product}`);
  return { amountMinor: amount, currency: process.env.PRICE_CURRENCY ?? "NGN" };
}

export const SIGNUP_CREDITS = PLANS.FREE.monthlyCredits;
export const LOW_CREDIT_RATIO = 0.1;
export const HEARTBEAT_SECONDS = 10;
export const STALE_AFTER_SECONDS = 30;
