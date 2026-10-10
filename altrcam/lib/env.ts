import { z } from "zod";
import { parseMinor, PRICE_ENV_NAMES } from "@/lib/plans";

/**
 * A price is optional (unset = that product is not on sale in that currency), but a value that is set must be a positive
 * whole number of minor units: the same rule lib/plans.ts applies when it reads it, so a typo is reported, not silently hidden.
 */
const optionalPrice = z.string().optional().refine((v) => v === undefined || v.trim() === "" || parseMinor(v) !== null, { message: "must be a positive whole number of minor units (kobo / cents), at most 2147483647" });
const prices = Object.fromEntries(PRICE_ENV_NAMES.map((n) => [n, optionalPrice])) as Record<string, typeof optionalPrice>;
/** Margin-guard inputs (lib/margin.ts). Optional: while unset nothing can be proven profitable, so nothing paid is on sale. */
const optionalNumber = (ok: (n: number) => boolean, message: string) =>
  z.string().optional().refine((v) => v === undefined || v.trim() === "" || (Number.isFinite(Number(v)) && ok(Number(v))), { message });

const schema = z.object({
  ...prices,
  FAL_COST_PER_SECOND_USD: optionalNumber((n) => n > 0, "must be a positive number of US dollars per second"),
  FX_NGN_PER_USD: optionalNumber((n) => n > 0, "must be a positive number of naira per US dollar"),
  MIN_MARGIN: optionalNumber((n) => n >= 0 && n < 1, "must be a number from 0 to just under 1 (0.5 = 50%)"),
  LIFETIME_MONTHLY_CREDITS: optionalNumber((n) => Number.isInteger(n) && n >= 0 && n <= 1_000_000, "must be a whole number of credits from 0 to 1000000"),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  FAL_KEY: z.string().min(1),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_PUBLIC_KEY: z.string().min(1),
  PAYSTACK_PLAN_PRO_MONTHLY: z.string().min(1),
  PAYSTACK_PLAN_PRO_YEARLY: z.string().min(1),
  NOWPAYMENTS_API_KEY: z.string().min(1),
  NOWPAYMENTS_IPN_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  NEXT_PUBLIC_APP_URL: z.string().url(),
  EMAIL_FROM: z.string().default("AltrCam <hello@altrcam.com>"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Validated server env. Throws a readable error listing every bad variable. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid environment: ${bad}`);
  }
  cached = parsed.data;
  return cached;
}

/** Names of missing/invalid variables (never values). Empty when everything validates. */
export function envIssues(source: NodeJS.ProcessEnv = process.env): string[] {
  const parsed = schema.safeParse(source);
  return parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
}
