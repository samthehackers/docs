import { databaseUrl } from "@/lib/database-url";
import { supabaseAdminConfig } from "@/lib/supabase/admin";

/**
 * Which integrations are configured, from env presence only (never connectivity, never values).
 * Used so public pages render without credentials and features that need a missing one say so honestly.
 */
const has = (...names: string[]) => names.every((n) => Boolean(process.env[n]?.trim()));
/** DATABASE_URL ?? POSTGRES_URL ?? POSTGRES_PRISMA_URL: the same answer lib/db.ts connects with. */
const databaseConfigured = () => Boolean(databaseUrl());

/** Supabase Auth in the browser and on the server: the project URL and a publishable (or legacy anon) key. */
export const supabaseConfigured = () =>
  has("NEXT_PUBLIC_SUPABASE_URL") && (has("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") || has("NEXT_PUBLIC_SUPABASE_ANON_KEY"));

/** The Google button is shown only when the owner has enabled the Google provider in Supabase and says so here. */
export const googleAuthEnabled = () => process.env.NEXT_PUBLIC_AUTH_GOOGLE_ENABLED === "true";

export function capabilities() {
  return {
    auth: supabaseConfigured(),
    database: databaseConfigured(), // presence only: a wrong, paused or unmigrated database is not detected
    storage: supabaseAdminConfig() !== null,
    liveTransformation: has("FAL_KEY"),
    paystack: has("PAYSTACK_SECRET_KEY"),
    nowpayments: has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"),
    email: has("RESEND_API_KEY"),
    rateLimiting: has("UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"),
    cron: has("CRON_SECRET"),
    pricesApproved: process.env.PRICING_APPROVED === "true",
  };
}
/**
 * Whether a visitor can really create and use an account: sign-in AND the database. Auth alone would let someone create a login
 * that then fails at the first app page (no database to hold their credits). This is environment presence only: a wrong, paused or
 * unmigrated database is not detected. Every public page that offers sign-up uses this one answer, so they cannot disagree.
 */
export const accountsOpen = () => supabaseConfigured() && databaseConfigured();

/** Whether checkout can work at all: accounts, and at least one payment provider. */
export const paymentsOpen = () => accountsOpen() && (has("PAYSTACK_SECRET_KEY") || has("NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET"));

export type Capabilities = ReturnType<typeof capabilities>;
