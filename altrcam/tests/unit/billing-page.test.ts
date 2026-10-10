/**
 * The real /billing and /billing/receipt/[reference] pages, the payment confirmation states and the cancel route, rendered and
 * run against an in-memory Postgres. Sign-in (requireAppUser / Clerk auth), the router and the provider's cancel call are faked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ db: null as unknown, userId: "A", cancel: vi.fn(async (_c: string, _t?: string) => {}) }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));
vi.mock("@/lib/session-user", () => ({
  requireAppUser: async () => {
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    return (await (h.db as import("@/lib/db").DB).select().from(users).where(eq(users.id, h.userId)))[0];
  },
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.userId }), clerkClient: async () => ({}) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ cancelSubscription: h.cancel }) }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { payments, subscriptions, users } from "@/db/schema";
import Billing from "@/app/(app)/billing/page";
import Receipt from "@/app/(app)/billing/receipt/[reference]/page";
import { PaymentState } from "@/components/billing/poll-status";
import { PAST_DUE_HELP } from "@/lib/public-copy";
import * as cancelRoute from "@/app/api/payments/cancel/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; (globalThis as { React?: unknown }).React = React; }, 60_000);
const ENV = { ...process.env };
beforeEach(async () => {
  h.userId = "A"; h.cancel.mockReset(); h.cancel.mockImplementation(async () => {});
  delete process.env.DATABASE_URL;
  Object.assign(process.env, {
    PAYSTACK_SECRET_KEY: "sk_x", NOWPAYMENTS_API_KEY: "np", NOWPAYMENTS_IPN_SECRET: "ipn",
    PRICE_PRO_MONTHLY_NGN: "1500000", PRICE_PRO_YEARLY_NGN: "15000000", PRICE_LIFETIME_NGN: "9900000", PRICE_LIFETIME_USD: "9900",
    PRICE_TOPUP_1K_NGN: "300000", PRICE_TOPUP_1K_USD: "300", FAL_COST_PER_SECOND_USD: "0.00001", FX_NGN_PER_USD: "1500",
  });
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
  await d.insert(users).values([{ id: "A", email: "a@x.co", name: "Ada" }, { id: "B", email: "b@x.co", name: "Bob" }]);
});
afterEach(() => { process.env = { ...ENV }; });

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const billing = async (plan?: string) => html((await Billing({ searchParams: Promise.resolve(plan ? { plan } : {}) })) as ReactElement);
const FUTURE = new Date("2099-05-06T00:00:00Z");
const subscribed = async (status = "active") => {
  await d.update(users).set({ plan: "PRO", planStatus: status, planRenewsAt: FUTURE }).where(eq(users.id, "A"));
  if (status !== "cancelling") await d.insert(subscriptions).values({ userId: "A", provider: "paystack", providerSubId: "SUB_A", emailToken: "tok", plan: "PRO", status: "active", currentPeriodEnd: FUTURE });
};

describe("/billing: plan, renewal and what can be bought", () => {
  it("a Pro subscriber sees the renewal date and a cancel button, and is NOT offered a second subscription", async () => {
    await subscribed();
    const t = text(await billing());
    expect(t).toContain("Renews May 6, 2099");
    expect(t).toContain("Cancel subscription");
    expect(t).not.toMatch(/Pro monthly ·|Pro yearly ·/);
    expect(t).toContain("Your current plan");
  });
  it("a Free user is offered Pro monthly and yearly by card, and Lifetime by card or crypto", async () => {
    const t = text(await billing());
    expect(t).toMatch(/Pro monthly · (₦|NGN\s?)15,000/);
    expect(t).toMatch(/Pro yearly · (₦|NGN\s?)150,000/);
    expect(t).toMatch(/Card · (₦|NGN\s?)99,000/);
    expect(t).toContain("Crypto · $99");
    expect(t).toContain("No subscription");
  });
  it("past_due reads as 'Payment failed' with what actually works, never the raw status", async () => {
    await subscribed("past_due");
    const s = await billing();
    expect(text(s)).toContain("Payment failed");
    expect(text(s)).toContain(PAST_DUE_HELP);
    expect(s).toMatch(/role="alert"/);
    expect(text(s)).not.toContain("past_due");
  });
  it("once cancelled, the cancel button is gone and the end date is shown", async () => {
    await subscribed("cancelling");
    const t = text(await billing());
    expect(t).not.toContain("Cancel subscription");
    expect(t).toContain("Pro stays active until May 6, 2099.");
  });
  it("a Lifetime member sees top-ups at the member price with the list price, and no plan purchases", async () => {
    await d.update(users).set({ plan: "LIFETIME" }).where(eq(users.id, "A"));
    const t = text(await billing());
    expect(t).toMatch(/(₦|NGN\s?)2,400/);
    expect(t).toMatch(/20% Lifetime discount \(list price (₦|NGN\s?)3,000\)/);
    expect(t).toContain("Your Lifetime discount is applied");
    expect(t).not.toMatch(/Pro monthly ·|Card · (₦|NGN\s?)99,000/);
  });
});

describe("/billing?plan=: resuming the plan picked on /pricing", () => {
  it("pre-selects a valid product with its checkout, and ignores anything that isn't a product id", async () => {
    const t = text(await billing("TOPUP_1K"));
    expect(t).toContain("Continue: 1,000 credits");
    expect(await billing("FREE_MONEY")).not.toContain('id="checkout"');
    expect(await billing("__proto__")).not.toContain('id="checkout"');
  });
  it("explains instead of offering when the account can't buy it", async () => {
    await subscribed();
    const t = text(await billing("PRO_MONTHLY"));
    expect(t).toContain("Continue: Pro (monthly)");
    expect(t).toContain("You already have an active Pro subscription");
    delete process.env.PRICE_TOPUP_1K_NGN; delete process.env.PRICE_TOPUP_1K_USD;
    expect(text(await billing("TOPUP_1K"))).toContain("This isn't on sale right now.");
  });
});

describe("/billing payment history", () => {
  it("uses plain status labels, links receipts for paid rows and offers 'Try again' for unfinished ones", async () => {
    await d.insert(payments).values([
      { userId: "A", provider: "paystack", reference: "alt_paid", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "success" },
      { userId: "A", provider: "paystack", reference: "alt_gone", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "abandoned" },
      { userId: "A", provider: "paystack", reference: "alt_bad", kind: "topup", product: "TOPUP_1K", amountMinor: 1, currency: "NGN", status: "rejected" },
    ]);
    const s = await billing();
    expect(text(s)).toMatch(/Paid .*Not completed|Not completed .*Paid/);
    expect(text(s)).toContain("Needs review");
    expect(text(s)).toContain("Try again");
    expect(s).toContain('href="/billing/receipt/alt_paid"');
    expect(s).not.toContain("/billing/receipt/alt_gone");
    expect(text(s)).not.toMatch(/\babandoned\b|\brejected\b/);
  });
});

describe("/billing/receipt/[reference]", () => {
  const receipt = async (reference: string) => html((await Receipt({ params: Promise.resolve({ reference }) })) as ReactElement);
  beforeEach(async () => {
    await d.insert(payments).values([
      { userId: "A", provider: "paystack", reference: "alt_mine", kind: "topup", product: "TOPUP_1K", amountMinor: 240000, currency: "NGN", status: "success", createdAt: new Date("2026-10-01T09:00:00Z") },
      { userId: "B", provider: "paystack", reference: "alt_bobs", kind: "lifetime", product: "LIFETIME", amountMinor: 9900000, currency: "NGN", status: "success" },
      { userId: "A", provider: "paystack", reference: "alt_unpaid", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "pending" },
    ]);
  });
  it("shows the owner's paid receipt with what was paid", async () => {
    const t = text(await receipt("alt_mine"));
    expect(t).toContain("AltrCam receipt");
    expect(t).toMatch(/(₦|NGN\s?)2,400/);
    expect(t).toContain("Oct 1, 2026");
    expect(t).toContain("alt_mine");
    expect(t).toContain("a@x.co");
  });
  it("another account's reference is a 404, and so is an unpaid one", async () => {
    await expect(receipt("alt_bobs")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(receipt("alt_unpaid")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
});

describe("the payment confirmation page", () => {
  it("after the polling limit it stops spinning and shows the reference with links to Billing and support", () => {
    const s = html(PaymentState({ status: "pending", timedOut: true, reference: "alt_late" }) as ReactElement);
    expect(text(s)).toContain("Still waiting for confirmation");
    expect(text(s)).toContain("alt_late");
    expect(s).toContain('href="/billing"');
    expect(s).toContain('href="/support"');
    expect(s).not.toContain("animate-spin");
  });
  it("a failed or abandoned payment says nothing was unlocked and gives the same way forward", () => {
    for (const status of ["failed", "abandoned", "rejected"]) {
      const s = html(PaymentState({ status, timedOut: false, reference: "alt_x" }) as ReactElement);
      expect(text(s), status).toContain("Nothing was unlocked");
      expect(s).toContain('href="/support"');
    }
  });
  it("the page only reads the status endpoint; nothing on it grants access", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/billing/poll-status.tsx", "utf8") + readFileSync("app/(app)/billing/success/page.tsx", "utf8");
    expect(src).toContain("/api/payments/status?reference=");
    expect(src).not.toMatch(/method:\s*"POST"|fulfil|grantCredits/);
  });
});

describe("POST /api/payments/cancel", () => {
  const cancel = async () => { const r = await cancelRoute.POST(); return { status: r.status, body: await r.json() }; };
  it("cancels at the provider, records it and answers with the end date", async () => {
    await subscribed();
    const r = await cancel();
    expect(r.status).toBe(200);
    expect(r.body.message).toContain("Pro stays active until May 6, 2099.");
    expect(h.cancel).toHaveBeenCalledWith("SUB_A", "tok");
    expect((await d.select().from(users).where(eq(users.id, "A")))[0].planStatus).toBe("cancelling");
  });
  it("a second click gets 404 'not_active' (the button shows 'Already cancelled')", async () => {
    await subscribed();
    await cancel();
    expect(await cancel()).toMatchObject({ status: 404, body: { code: "not_active" } });
  });
  it("if the provider refuses, nothing is recorded and the answer is a clear 502", async () => {
    await subscribed();
    h.cancel.mockRejectedValueOnce(new Error("paystack 500"));
    const r = await cancel();
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/nothing changed and it will still renew/);
    expect((await d.select().from(subscriptions))[0].status).toBe("active");
  });
});
