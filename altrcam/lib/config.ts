/**
 * Which integrations are configured, from env presence only (never connectivity, never values).
 * Used so public pages render without credentials and features that need a missing one say so honestly.
 */
const has = (...names: string[]) => names.every((n) => Boolean(process.env[n]));
const databaseConfigured = () => has("DATABASE_URL") || has("POSTGRES_URL") || has("POSTGRES_PRISMA_URL");

export const supabaseConfigured = () => has("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
/** Kept as a compatibility alias for older feature gates during the auth migration. */
export const clerkConfigured = supabaseConfigured;

export function capabilities() {
  return {
    auth: clerkConfigured(),
    database: databaseConfigured(), // presence only: a wrong, paused or unmigrated database is not detected
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
/**
 * Whether a visitor can really create and use an account: sign-in AND the database. Clerk alone would let someone create a login
 * that then fails at the first app page (no database to hold their credits). This is environment presence only: a wrong, paused or
 * unmigrated database is not detected. Every public page that offers sign-up uses this one answer, so they cannot disagree.
 */
export const accountsOpen = () => supabaseConfigured() && databaseConfigured();

/** Whether checkout can work at all: accounts, and at least one payment provider. */
export const paymentsOpen = () => accountsOpen() && (has("PAYSTACK_SECRET_KEY") || has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"));

export type Capabilities = ReturnType<typeof capabilities>;
