import { afterEach, describe, expect, it } from "vitest";
import { accountsOpen, capabilities, supabaseConfigured, paymentsOpen } from "@/lib/config";
import { envIssues } from "@/lib/env";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
const clear = (...names: string[]) => names.forEach((n) => delete process.env[n]);

describe("capabilities", () => {
  it("reports everything off with no credentials", () => {
    clear("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "CRON_SECRET", "FAL_KEY", "PAYSTACK_SECRET_KEY", "NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET", "RESEND_API_KEY", "PRICING_APPROVED");
    const c = capabilities();
    expect(Object.values({ ...c, pricesApproved: false }).every((v) => v === false)).toBe(true);
    expect(supabaseConfigured()).toBe(false);
  });
  it("needs both Supabase keys, and both NOWPayments values", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    clear("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(supabaseConfigured()).toBe(false);
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "pk_test_x";
    expect(supabaseConfigured()).toBe(true);
    process.env.NOWPAYMENTS_API_KEY = "k"; clear("NOWPAYMENTS_IPN_SECRET");
    expect(capabilities().nowpayments).toBe(false);
  });
  it("treats empty strings as unset (what CI passes for the no-credential build)", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ""; process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "";
    expect(supabaseConfigured()).toBe(false);
  });
  it("prices are unapproved unless explicitly approved", () => {
    clear("PRICING_APPROVED");
    expect(capabilities().pricesApproved).toBe(false);
    process.env.PRICING_APPROVED = "yes";
    expect(capabilities().pricesApproved).toBe(false);
    process.env.PRICING_APPROVED = "true";
    expect(capabilities().pricesApproved).toBe(true);
  });
  it("never exposes values, only booleans", () => {
    process.env.FAL_KEY = "super-secret-value";
    expect(JSON.stringify(capabilities())).not.toContain("super-secret-value");
  });
});

describe("the Vercel Supabase integration's variable names count", () => {
  const set = (o: Record<string, string | undefined>) => Object.entries(o).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  it("the legacy anon key works in place of the publishable key", () => {
    set({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" });
    expect(supabaseConfigured()).toBe(true);
  });
  it("POSTGRES_URL alone opens accounts (there is no DATABASE_URL on the integration)", () => {
    set({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk", DATABASE_URL: undefined, POSTGRES_PRISMA_URL: undefined, POSTGRES_URL: "postgres://u:p@h:6543/postgres?sslmode=require&supa=base-pooler.x" });
    expect(capabilities().database).toBe(true);
    expect(accountsOpen()).toBe(true);
  });
  it("storage takes SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY", () => {
    set({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: undefined, SUPABASE_SECRET_KEY: "sb_secret_x" });
    expect(capabilities().storage).toBe(true);
    set({ SUPABASE_SECRET_KEY: undefined });
    expect(capabilities().storage).toBe(false);
  });
  it("envIssues accepts the integration's names, so production does not log a false alarm for them", () => {
    const issues = envIssues({ NODE_ENV: "production", POSTGRES_URL: "postgres://u:p@h:6543/postgres", SUPABASE_SECRET_KEY: "s", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a" } as NodeJS.ProcessEnv);
    expect(issues).not.toContain("DATABASE_URL");
    expect(issues).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(issues).not.toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    expect(issues.join(" ")).not.toMatch(/CLERK/);
  });
  it("no capability refers to a removed integration", () => {
    expect(Object.keys(capabilities())).not.toContain("webhooks");
  });
});

describe("envIssues", () => {
  it("lists names of missing variables, not values", () => {
    const issues = envIssues({ NODE_ENV: "production", FAL_KEY: "do-not-leak" } as NodeJS.ProcessEnv);
    expect(issues).toContain("DATABASE_URL");
    expect(issues).not.toContain("FAL_KEY");
    expect(issues.join(" ")).not.toContain("do-not-leak");
  });
});

describe("accountsOpen and paymentsOpen", () => {
  const set = (o: Record<string, string | undefined>) => Object.entries(o).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
  const NONE = { NEXT_PUBLIC_SUPABASE_URL: undefined, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined, DATABASE_URL: undefined, POSTGRES_URL: undefined, POSTGRES_PRISMA_URL: undefined, PAYSTACK_SECRET_KEY: undefined, NOWPAYMENTS_API_KEY: undefined, NOWPAYMENTS_IPN_SECRET: undefined };
  it("accounts need both Supabase keys AND a database: any one missing is closed", () => {
    set(NONE);
    expect(accountsOpen()).toBe(false);
    set({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk" });
    expect(accountsOpen()).toBe(false); // Auth alone would create logins that then fail at the first page
    set({ DATABASE_URL: "postgres://x" });
    expect(accountsOpen()).toBe(true);
    set({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined });
    expect(accountsOpen()).toBe(false);
    set({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk", NEXT_PUBLIC_SUPABASE_URL: undefined });
    expect(accountsOpen()).toBe(false);
    set({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", DATABASE_URL: "" });
    expect(accountsOpen()).toBe(false); // empty counts as unset
  });
  it("checkout needs open accounts and a complete payment provider", () => {
    set({ ...NONE, NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pk", DATABASE_URL: "postgres://x" });
    expect(paymentsOpen()).toBe(false);
    set({ PAYSTACK_SECRET_KEY: "p" });
    expect(paymentsOpen()).toBe(true);
    set({ PAYSTACK_SECRET_KEY: undefined, NOWPAYMENTS_API_KEY: "k" });
    expect(paymentsOpen()).toBe(false);
    set({ NOWPAYMENTS_IPN_SECRET: "s" });
    expect(paymentsOpen()).toBe(true);
    set({ DATABASE_URL: undefined });
    expect(paymentsOpen()).toBe(false); // a provider without accounts is no checkout
  });
});

