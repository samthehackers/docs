import { afterEach, describe, expect, it } from "vitest";
import { accountsOpen, capabilities, clerkConfigured, paymentsOpen } from "@/lib/config";
import { envIssues } from "@/lib/env";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });
const clear = (...names: string[]) => names.forEach((n) => delete process.env[n]);

describe("capabilities", () => {
  it("reports everything off with no credentials", () => {
    clear("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "DATABASE_URL", "FAL_KEY", "PAYSTACK_SECRET_KEY", "NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET", "RESEND_API_KEY", "PRICING_APPROVED");
    const c = capabilities();
    expect(Object.values({ ...c, pricesApproved: false }).every((v) => v === false)).toBe(true);
    expect(clerkConfigured()).toBe(false);
  });
  it("needs both Clerk keys, and both NOWPayments values", () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x";
    clear("CLERK_SECRET_KEY");
    expect(clerkConfigured()).toBe(false);
    process.env.CLERK_SECRET_KEY = "sk_test_x";
    expect(clerkConfigured()).toBe(true);
    process.env.NOWPAYMENTS_API_KEY = "k"; clear("NOWPAYMENTS_IPN_SECRET");
    expect(capabilities().nowpayments).toBe(false);
  });
  it("treats empty strings as unset (what CI passes for the no-credential build)", () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = ""; process.env.CLERK_SECRET_KEY = "";
    expect(clerkConfigured()).toBe(false);
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
  const NONE = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined, CLERK_SECRET_KEY: undefined, DATABASE_URL: undefined, PAYSTACK_SECRET_KEY: undefined, NOWPAYMENTS_API_KEY: undefined, NOWPAYMENTS_IPN_SECRET: undefined };
  it("accounts need both Clerk keys AND a database: any one missing is closed", () => {
    set(NONE);
    expect(accountsOpen()).toBe(false);
    set({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk", CLERK_SECRET_KEY: "sk" });
    expect(accountsOpen()).toBe(false); // Clerk alone would create logins that then fail at the first page
    set({ DATABASE_URL: "postgres://x" });
    expect(accountsOpen()).toBe(true);
    set({ CLERK_SECRET_KEY: undefined });
    expect(accountsOpen()).toBe(false);
    set({ CLERK_SECRET_KEY: "sk", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined });
    expect(accountsOpen()).toBe(false);
    set({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk", DATABASE_URL: "" });
    expect(accountsOpen()).toBe(false); // empty counts as unset
  });
  it("checkout needs open accounts and a complete payment provider", () => {
    set({ ...NONE, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk", CLERK_SECRET_KEY: "sk", DATABASE_URL: "postgres://x" });
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

