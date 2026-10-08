import { z } from "zod";

const num = z.coerce.number().int().nonnegative();

const schema = z.object({
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
  PRICE_CURRENCY: z.enum(["NGN", "USD"]).default("NGN"),
  PRICE_PRO_MONTHLY: num,
  PRICE_PRO_YEARLY: num,
  PRICE_LIFETIME: num,
  PRICE_TOPUP_1K: num,
  PRICE_TOPUP_5K: num,
  PRICE_TOPUP_15K: num,
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
