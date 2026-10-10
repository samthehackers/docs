/** Single source of truth for plans, products, prices and limits. 1 credit = 1 second of realtime AI output. */
export type Plan = "FREE" | "PRO" | "LIFETIME";
export type Resolution = "low" | "high";
/**
 * The camera size the Studio asks the browser for, per plan. It is a request ("ideal"): the camera may deliver
 * something else, and the AI service decides what it sends back. Public pages describe it as camera capture only.
 */
export const CAPTURE_SIZE: Record<Resolution, { width: number; height: number }> = {
  low: { width: 640, height: 360 },
  high: { width: 1280, height: 720 },
};
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

/** Defaults. Admin overrides live in the plan_config table; read effective limits with getPlans() in lib/plan-config.ts. */
export const DEFAULT_PLANS: Record<Plan, PlanConfig> = {
  FREE: { label: "Free", monthlyCredits: 300, maxSessionSeconds: 120, maxResolution: "low", presets: 3, historyDays: 7, clipRecording: false },
  PRO: { label: "Pro", monthlyCredits: 6000, maxSessionSeconds: 1800, maxResolution: "high", presets: 100, historyDays: 365, clipRecording: true },
  LIFETIME: { label: "Lifetime", monthlyCredits: 6000, maxSessionSeconds: 1800, maxResolution: "high", presets: 100, historyDays: null, clipRecording: true },
};

/**
 * Prices are set per currency. Paystack (card) charges NGN; NOWPayments (crypto) is priced in USD. One provider per
 * currency, so the price shown next to a button is the price that button charges.
 */
export type Currency = "NGN" | "USD";
export const CURRENCIES: readonly Currency[] = ["NGN", "USD"];
export type PayProvider = "paystack" | "nowpayments";
export const CURRENCY_FOR_PROVIDER: Record<PayProvider, Currency> = { paystack: "NGN", nowpayments: "USD" };
export const PROVIDER_FOR_CURRENCY: Record<Currency, PayProvider> = { NGN: "paystack", USD: "nowpayments" };

export interface ProductConfig {
  id: ProductId;
  kind: "subscription" | "lifetime" | "topup";
  label: string;
  /** Plan granted (subscription/lifetime). */
  plan?: Plan;
  /** Top-up packs: credits granted (purchased bucket). For subscription/lifetime this is only the default allowance; fulfilment uses the effective plan config. */
  credits: number;
  /** Subscription period length in days. */
  periodDays?: number;
  /** Env var holding the price in minor units (kobo / cents), per currency. Unset = not on sale in that currency. */
  priceEnv: Record<Currency, string>;
}

const priceEnv = (base: string): Record<Currency, string> => ({ NGN: `PRICE_${base}_NGN`, USD: `PRICE_${base}_USD` });

export const PRODUCTS: Record<ProductId, ProductConfig> = {
  PRO_MONTHLY: { id: "PRO_MONTHLY", kind: "subscription", label: "Pro (monthly)", plan: "PRO", credits: DEFAULT_PLANS.PRO.monthlyCredits, periodDays: 31, priceEnv: priceEnv("PRO_MONTHLY") },
  PRO_YEARLY: { id: "PRO_YEARLY", kind: "subscription", label: "Pro (yearly)", plan: "PRO", credits: DEFAULT_PLANS.PRO.monthlyCredits, periodDays: 366, priceEnv: priceEnv("PRO_YEARLY") },
  LIFETIME: { id: "LIFETIME", kind: "lifetime", label: "Lifetime", plan: "LIFETIME", credits: DEFAULT_PLANS.LIFETIME.monthlyCredits, priceEnv: priceEnv("LIFETIME") },
  TOPUP_1K: { id: "TOPUP_1K", kind: "topup", label: "1,000 credits", credits: 1000, priceEnv: priceEnv("TOPUP_1K") },
  TOPUP_5K: { id: "TOPUP_5K", kind: "topup", label: "5,000 credits", credits: 5000, priceEnv: priceEnv("TOPUP_5K") },
  TOPUP_15K: { id: "TOPUP_15K", kind: "topup", label: "15,000 credits", credits: 15000, priceEnv: priceEnv("TOPUP_15K") },
};

export const PRODUCT_IDS = Object.keys(PRODUCTS) as ProductId[];
export const TOPUP_IDS: ProductId[] = ["TOPUP_1K", "TOPUP_5K", "TOPUP_15K"];
/** Every price variable the app reads (12: six products, two currencies), for env validation and the docs. */
export const PRICE_ENV_NAMES: string[] = PRODUCT_IDS.flatMap((id) => CURRENCIES.map((c) => PRODUCTS[id].priceEnv[c]));

export function isProductId(v: string): v is ProductId {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, v);
}

/** Whether a provider can sell this product at all. Crypto has no recurring billing, so subscriptions are card (NGN) only. */
export function providerSells(provider: PayProvider, product: ProductId): boolean {
  return !(provider === "nowpayments" && PRODUCTS[product].kind === "subscription");
}

/** Where prices are read from: process.env in the app; a plain object in tests and the preflight table. */
export type EnvSource = Record<string, string | undefined>;

/** payments.amount_minor is a Postgres integer: a larger price could not even be recorded, so it is treated as invalid. */
export const MAX_PRICE_MINOR = 2_147_483_647;

/** A price variable's value: a positive whole number of minor units that fits a payment row, else null (unset, empty, decimal, zero, negative, too big, garbage). */
export function parseMinor(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_PRICE_MINOR ? n : null;
}

/** The configured list price in minor units, read at call time; null when that currency has no valid price. Never throws. */
export function listPrice(product: ProductId, currency: Currency, env: EnvSource = process.env): number | null {
  return parseMinor(env[PRODUCTS[product].priceEnv[currency]]);
}

/** What this buyer is charged in minor units, or null when the product has no price in that currency. */
export function buyerPrice(product: ProductId, currency: Currency, _buyerPlan?: Plan | null, env: EnvSource = process.env): number | null {
  return listPrice(product, currency, env);
}

export const LOW_CREDIT_RATIO = 0.1;
export const HEARTBEAT_SECONDS = 10;
export const STALE_AFTER_SECONDS = 30;

/** Referral program. The referrer is rewarded once, when the friend first pays for Pro or Lifetime. */
export const REFERRAL = {
  rewardCredits: 600, // 10 minutes of live video, purchased bucket (never expires)
  rewardKinds: ["subscription", "lifetime"] as const, // top-ups don't count: too cheap to farm
  maxRewardsPerReferrer: 20,
  claimWindowDays: 1, // the friend must claim within this long of signing up (normally the first page load)
  cookie: "altrcam_ref",
  cookieDays: 30,
  codePattern: /^[a-f0-9]{8}$/,
};
