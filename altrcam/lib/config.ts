/**
 * Which integrations are configured, from env presence only (never connectivity, never values).
 * Used so public pages render without credentials and features that need a missing one say so honestly.
 */
const has = (...names: string[]) => names.every((n) => Boolean(process.env[n]));

export const clerkConfigured = () => has("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY");

export function capabilities() {
  return {
    auth: clerkConfigured(),
    database: has("DATABASE_URL"), // presence only: a wrong, paused or unmigrated database is not detected
    storage: has("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"),
    liveTransformation: has("FAL_KEY"),
    paystack: has("PAYSTACK_SECRET_KEY"),
    nowpayments: has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"),
    email: has("RESEND_API_KEY"),
    rateLimiting: has("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"),
    webhooks: has("CLERK_WEBHOOK_SECRET"),
    cron: has("CRON_SECRET"),
    pricesApproved: process.env.PRICING_APPROVED === "true",
    signups: accountsOpen(),
  };
}

/**
 * The owner's explicit sign-up switch: SIGNUPS_OPEN, "true" or "false", unset means "false". Only the exact string "true" turns it
 * on, so a typo can only ever keep sign-up closed. A Production build with it on but credentials missing fails (next.config.ts,
 * lib/build-check.ts); with it off the build passes and the site says sign-up isn't open. See docs/SETUP.md.
 */
export const signupsSwitchedOn = () => process.env.SIGNUPS_OPEN === "true";

/**
 * Whether an existing account can sign in: Clerk AND the database. Clerk alone would let someone hold a login that then fails at the
 * first app page (no database to hold their credits). Independent of SIGNUPS_OPEN, so pausing sign-up never locks existing users out.
 * This is environment presence only: a wrong, paused or unmigrated database is not detected.
 */
export const signInOpen = () => clerkConfigured() && has("DATABASE_URL");

/**
 * Whether a visitor can create an account: the owner switched sign-up on (SIGNUPS_OPEN=true) AND sign-in works (both Clerk keys and
 * DATABASE_URL). Every public page that offers sign-up uses this one answer, so they cannot disagree.
 */
export const accountsOpen = () => signupsSwitchedOn() && signInOpen();

/** Whether checkout can work at all: accounts, and at least one payment provider. */
export const paymentsOpen = () => accountsOpen() && (has("PAYSTACK_SECRET_KEY") || has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"));

export type Capabilities = ReturnType<typeof capabilities>;
