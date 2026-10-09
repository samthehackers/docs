/** Single source of truth for plans, products and limits. 1 credit = 1 second of realtime AI output. */
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
  priceEnv: string;
}

export const PRODUCTS: Record<ProductId, ProductConfig> = {
  PRO_MONTHLY: { id: "PRO_MONTHLY", kind: "subscription", label: "Pro (monthly)", plan: "PRO", credits: DEFAULT_PLANS.PRO.monthlyCredits, periodDays: 31, priceEnv: "PRICE_PRO_MONTHLY" },
  PRO_YEARLY: { id: "PRO_YEARLY", kind: "subscription", label: "Pro (yearly)", plan: "PRO", credits: DEFAULT_PLANS.PRO.monthlyCredits, periodDays: 366, priceEnv: "PRICE_PRO_YEARLY" },
  LIFETIME: { id: "LIFETIME", kind: "lifetime", label: "Lifetime", plan: "LIFETIME", credits: DEFAULT_PLANS.LIFETIME.monthlyCredits, priceEnv: "PRICE_LIFETIME" },
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
