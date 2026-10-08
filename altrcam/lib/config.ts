/**
 * Which integrations are configured, from env presence only (never connectivity, never values).
 * Used so public pages render without credentials and features that need a missing one say so honestly.
 */
const has = (...names: string[]) => names.every((n) => Boolean(process.env[n]));

export const clerkConfigured = () => has("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY");

export function capabilities() {
  return {
    auth: clerkConfigured(),
    database: has("DATABASE_URL"),
    storage: has("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"),
    liveTransformation: has("FAL_KEY"),
    paystack: has("PAYSTACK_SECRET_KEY"),
    nowpayments: has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"),
    email: has("RESEND_API_KEY"),
    rateLimiting: has("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"),
    webhooks: has("CLERK_WEBHOOK_SECRET"),
    cron: has("CRON_SECRET"),
    pricesApproved: process.env.PRICING_APPROVED === "true",
  };
}
export type Capabilities = ReturnType<typeof capabilities>;
