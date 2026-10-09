/**
 * The real /dashboard, /support and /history server components, rendered to HTML against a real in-memory Postgres,
 * with only the sign-in (requireAppUser), storage signing and two client-only widgets stubbed. This is what a signed-in
 * person's page contains: the wording, the empty states and the plan-dependent parts, and nothing from another account.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ db: null as unknown, userId: "A" }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));
vi.mock("@/lib/session-user", () => ({
  requireAppUser: async () => {
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    return ((await (h.db as import("@/lib/db").DB).select().from(users).where(eq(users.id, h.userId))))[0];
  },
}));
vi.mock("@/lib/storage", () => ({ signedReadUrl: async (p: string) => `https://signed.example/${p}` }));
// Client components that need the Next router at render time; the pages are what is under test here.
vi.mock("@/components/history-actions", () => ({ HistoryActions: () => null }));
vi.mock("@/components/ticket-form", () => ({ TicketForm: () => "TICKET_FORM_PRESENT" }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, payments, presets, studioSessions, subscriptions, supportTickets, transformations, users } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import { invalidatePlanCache, setPlanConfig } from "@/lib/plan-config";
import { DEFAULT_PLANS } from "@/lib/plans";
import Dashboard from "@/app/(app)/dashboard/page";
import Support from "@/app/(app)/support/page";
import History from "@/app/(app)/history/page";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

const SESSION = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const FUTURE = new Date(Date.now() + 10 * 86_400_000);

beforeEach(async () => {
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x";
  delete process.env.DATABASE_URL;
  invalidatePlanCache();
  h.userId = "A";
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, transformations, presets, support_tickets, plan_config restart identity cascade`);
  await d.insert(users).values([
    { id: "A", email: "ada@example.com", name: "Ada Lovelace", avatarUrl: "https://img.clerk.com/ada.png", createdAt: new Date("2026-01-15T10:00:00Z") },
    { id: "B", email: "bob@example.com", name: "Bob Other" },
  ]);
});

/** Plain text of rendered HTML, so assertions read like what a person sees. */
const text = (el: ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const html = (el: ReactElement) => renderToStaticMarkup(el);
const dash = async () => (await Dashboard()) as ReactElement;
const setPlan = (userId: string, plan: "FREE" | "PRO" | "LIFETIME", planStatus = "active", planRenewsAt: Date | null = null) =>
  d.update(users).set({ plan, planStatus, planRenewsAt }).where(eq(users.id, userId));
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

describe("/dashboard", () => {
  it("shows the profile block: avatar, full name, email, member since, plan and a link to Settings", async () => {
    await grantCredits(d, "A", 300, "monthly", "signup_grant");
    const out = html(await dash());
    const t = text(await dash());
    expect(t).toContain("Welcome back, Ada");
    expect(t).toContain("Ada Lovelace");
    expect(t).toContain("ada@example.com");
    expect(t).toContain("Member since January 2026");
    expect(out).toContain('src="https://img.clerk.com/ada.png"');
    expect(out).toMatch(/href="\/settings"[^>]*>Manage profile/);
  });
  it("keeps one prominent Open Studio action", async () => {
    const out = html(await dash());
    expect(countOf(out, ">Open Studio<") + countOf(out, "Open Studio</a>")).toBeGreaterThanOrEqual(1);
    expect(out.match(/<a [^>]*href="\/studio"[^>]*>(?:<svg[^>]*>.*?<\/svg>)? ?Open Studio<\/a>/g)).toHaveLength(1);
  });

  it("a Free user sees the upgrade card with the real Free and Pro limits, linking to Billing", async () => {
    const t = text(await dash());
    expect(t).toContain("Upgrade to Pro");
    expect(t).toContain("Credits per month 300 6,000");
    expect(t).toContain("Longest session 2 min 30 min");
    expect(t).toContain("Saved presets 3 100");
    expect(t).toContain("History kept 7 days 365 days");
    expect(html(await dash())).toMatch(/href="\/billing"[^>]*>See Pro plans/);
  });
  it("the upgrade card follows admin changes to plan limits", async () => {
    process.env.DATABASE_URL = "postgres://unused/ignored"; // makes getPlans() read the (mocked) database
    await setPlanConfig(d, "PRO", { ...DEFAULT_PLANS.PRO, monthlyCredits: 9000, maxSessionSeconds: 3600 }, "admin");
    const t = text(await dash());
    expect(t).toContain("Credits per month 300 9,000");
    expect(t).toContain("Longest session 2 min 60 min");
  });
  it("says so when checkout is not available on this deployment", async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    expect(text(await dash())).toContain("Payments aren't available on this deployment yet");
  });
  it.each([
    ["PRO", "active", "Renews"],
    ["LIFETIME", "active", "No renewal needed"],
  ] as const)("a %s user does not get the Free upgrade card", async (plan, status, shown) => {
    await setPlan("A", plan, status, plan === "PRO" ? FUTURE : null);
    if (plan === "PRO") await d.insert(subscriptions).values({ userId: "A", provider: "paystack", providerSubId: "S", plan: "PRO", status: "active" });
    const t = text(await dash());
    expect(t).not.toContain("Upgrade to Pro");
    expect(t).not.toContain("How Pro differs");
    expect(t).toContain(shown);
  });

  it("payment and subscription status: active Pro with renewal date and the last payment", async () => {
    await setPlan("A", "PRO", "active", new Date("2026-12-01T00:00:00Z"));
    await d.insert(subscriptions).values({ userId: "A", provider: "paystack", providerSubId: "S", plan: "PRO", status: "active" });
    await d.insert(payments).values({ userId: "A", provider: "paystack", reference: "r1", kind: "subscription", product: "PRO_MONTHLY", amountMinor: 500000, currency: "NGN", status: "success", createdAt: new Date("2026-11-01T00:00:00Z") });
    const t = text(await dash());
    expect(t).toContain("Active");
    expect(t).toContain("Renews Dec 1, 2026");
    expect(t).toMatch(/Last payment: .*5,000.* for Pro \(monthly\) on Nov 1, 2026/);
    expect(html(await dash())).not.toContain("payment failed");
  });
  it("payment and subscription status: cancelling shows when Pro ends", async () => {
    await setPlan("A", "PRO", "cancelling", new Date("2026-12-01T00:00:00Z"));
    const t = text(await dash());
    expect(t).toContain("Cancelled");
    expect(t).toContain("Pro stays active until Dec 1, 2026.");
  });
  it("payment and subscription status: past_due shows a clear warning banner that links to Billing", async () => {
    await setPlan("A", "PRO", "past_due", FUTURE);
    const out = html(await dash());
    expect(out).toMatch(/role="alert"[^>]*>.*?renewal payment failed/s);
    expect(out).toMatch(/href="\/billing"[^>]*>Go to Billing/);
    expect(text(await dash())).toContain("Payment failed");
  });
  it("payment and subscription status: an expired plan says Pro ended and has no alert banner", async () => {
    await setPlan("A", "FREE", "expired", null);
    await grantCredits(d, "A", 300, "monthly", "signup_grant");
    const t = text(await dash());
    expect(t).toContain("Pro ended");
    expect(html(await dash())).not.toContain('role="alert"');
  });
  it("shows 'No payments yet' for someone who never paid", async () => {
    expect(text(await dash())).toContain("No payments yet.");
  });

  it("shows the remaining allowance as a number and a meter", async () => {
    await grantCredits(d, "A", 300, "monthly", "signup_grant");
    await d.insert(creditLedger).values({ userId: "A", delta: -75, bucket: "monthly", reason: "session" });
    const out = html(await dash());
    const t = text(await dash());
    expect(t).toContain("25%");
    expect(t).toContain("75 of 300 credits used this month");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="25"');
  });
  it("a plan with a zero monthly allowance shows no meter and never prints NaN", async () => {
    process.env.DATABASE_URL = "postgres://unused/ignored";
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 }, "admin");
    const out = html(await dash());
    const t = text(await dash());
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("Infinity");
    expect(out).not.toContain('role="progressbar"');
    expect(t).toContain("Your plan doesn't include monthly credits");
    expect(t).toContain("You're out of credits."); // the banner still fires at a zero balance
  });
  it("a zero allowance with purchased credits left shows no low-credit banner", async () => {
    process.env.DATABASE_URL = "postgres://unused/ignored";
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 }, "admin");
    await grantCredits(d, "A", 400, "purchased", "topup_purchase");
    const t = text(await dash());
    expect(t).not.toContain("out of credits");
    expect(t).not.toContain("running low");
    expect(t).toContain("400");
  });
  it("the low-credit banner offers Upgrade to Pro to Free users and only Top up to Pro users", async () => {
    await grantCredits(d, "A", 10, "monthly", "signup_grant");
    let t = text(await dash());
    expect(t).toContain("You're running low on credits.");
    expect(t).toMatch(/Upgrade to Pro Top up/);
    await setPlan("A", "PRO", "active", FUTURE);
    t = text(await dash());
    expect(t).toContain("running low");
    expect(t).not.toContain("Upgrade to Pro");
    expect(t).toContain("Top up");
  });

  it("lists saved presets with a count, the cap and links into the Studio, and links to /presets", async () => {
    const [p1] = await d.insert(presets).values({ userId: "A", name: "Neon anime", kind: "style", prompt: "x" }).returning({ id: presets.id });
    const out = html(await dash());
    expect(out).toContain(`href="/studio?preset=${p1.id}"`);
    expect(out).toContain("Neon anime");
    expect(text(await dash())).toContain("1 of 3 used");
    expect(out).toMatch(/href="\/presets"[^>]*>Manage presets/);
  });
  it("explains an empty preset list", async () => {
    expect(text(await dash())).toContain("No saved presets yet.");
  });

  it("shows usage history: sessions with date, length, credits and how they ended, plus credit changes", async () => {
    await grantCredits(d, "A", 300, "monthly", "signup_grant");
    await grantCredits(d, "A", 1000, "purchased", "topup_purchase");
    await d.insert(studioSessions).values({
      id: SESSION(1), userId: "A", maxSeconds: 120, secondsBilled: 125, startedAt: new Date("2026-03-02T10:00:00Z"), endedAt: new Date("2026-03-02T10:02:05Z"),
      endReason: "session_limit", settings: { prompt: "a friendly robot", expand: true, kind: "prompt" },
    });
    const t = text(await dash());
    expect(t).toContain("Usage history");
    expect(t).toContain("Mar 2, 2026 · 2m 05s");
    expect(t).toContain("a friendly robot");
    expect(t).toContain("125 credits");
    expect(t).toContain("Reached your plan's session limit");
    expect(t).toContain("Signup credits");
    expect(t).toContain("Top-up purchased");
    expect(t).toContain("+1,000");
  });
  it("explains empty usage history", async () => {
    const t = text(await dash());
    expect(t).toContain("No live sessions yet.");
    expect(t).toContain("No credit changes yet.");
  });
  it("explains that snapshots are what appear under recent transformations, and links to History", async () => {
    const t = text(await dash());
    expect(t).toContain("Nothing saved yet. Press Snapshot in the Studio");
    expect(html(await dash())).toMatch(/href="\/history"[^>]*>View history/);
  });

  it("contains nothing that belongs to another account", async () => {
    await setPlan("B", "PRO", "past_due", FUTURE);
    await grantCredits(d, "B", 4242, "purchased", "topup_purchase");
    await d.insert(presets).values({ userId: "B", name: "Bob's secret preset", kind: "prompt", prompt: "bobprompt" });
    await d.insert(payments).values({ userId: "B", provider: "paystack", reference: "bobref", kind: "topup", product: "TOPUP_15K", amountMinor: 987654, currency: "NGN", status: "success" });
    await d.insert(studioSessions).values({ id: SESSION(9), userId: "B", maxSeconds: 120, secondsBilled: 77, settings: { prompt: "bobsession" } });
    await d.insert(transformations).values({ userId: "B", title: "bobclip", prompt: "bobprompt" });
    await d.insert(subscriptions).values({ userId: "B", provider: "paystack", providerSubId: "BS", plan: "PRO", status: "active" });
    const t = text(await dash());
    for (const leak of ["Bob", "bob@", "secret", "bobprompt", "bobsession", "bobclip", "4,242", "9,876", "15,000 credits", "payment failed", "Pro (monthly)"]) expect(t).not.toContain(leak);
  });
});

describe("/support", () => {
  const page = async () => (await Support()) as ReactElement;

  it("keeps the ticket form and lists only the user's own tickets", async () => {
    await d.insert(supportTickets).values([{ userId: "A", subject: "My own ticket", body: "hello hello" }, { userId: "B", subject: "Bob's ticket", body: "bob problem" }]);
    const t = text(await page());
    expect(t).toContain("TICKET_FORM_PRESENT");
    expect(t).toContain("My own ticket");
    expect(t).not.toContain("Bob's ticket");
    expect(t).not.toContain("bob problem");
  });
  it("has a troubleshooting section covering every required topic", async () => {
    const out = html(await page());
    const t = text(await page());
    expect(t).toContain("Support and troubleshooting");
    for (const id of ["camera", "connection", "credits", "ended", "payments", "delete", "video-only"]) expect(out).toContain(`id="${id}"`);
    // camera
    expect(t).toMatch(/allow the camera/i);
    expect(t).toMatch(/another app|other apps/i);
    expect(t).toContain("https://");
    // connection
    expect(t).toMatch(/VPN/);
    expect(t).toMatch(/firewall/i);
    expect(t).toContain("Connecting");
    expect(t).toMatch(/Failed or Closed/);
    // credits
    expect(t).toContain("1 credit = 1 second");
    expect(t).toMatch(/monthly credits/i);
    expect(t).toMatch(/used only after your monthly credits/i);
    // ended by itself
    expect(t).toMatch(/session length/i);
    expect(t).toMatch(/checking in|check-in/i);
    // payments
    expect(t).toMatch(/charged twice/i);
    expect(t).toMatch(/Refunds are not automatic/);
    // deletion
    expect(t).toMatch(/Delete account/);
    // video only
    expect(t).toMatch(/Only video/);
    expect(t).toMatch(/does not use your microphone/i);
  });
  it("reads session limits and allowances from the effective plan config", async () => {
    process.env.DATABASE_URL = "postgres://unused/ignored";
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, maxSessionSeconds: 90, monthlyCredits: 123 }, "admin");
    const t = text(await page());
    expect(t).toContain("Free sessions can last up to 1 min 30 sec");
    expect(t).toContain("123 on Free");
  });
  it("promises no response time and no refund, and does not claim the live connection is verified", async () => {
    const t = text(await page());
    expect(t).not.toMatch(/within \d|\d+ ?(hours?|business days?)|24\/7|guarantee|instantly|always works|fully refund/i);
    expect(t).toMatch(/may be on our side/);
  });
});

describe("/history", () => {
  const page = async (sp: Record<string, string> = {}) => (await History({ searchParams: Promise.resolve(sp) })) as ReactElement;

  it("an empty history explains that snapshots are saved manually from the Studio", async () => {
    const t = text(await page());
    expect(t).toContain("Nothing saved yet.");
    expect(t).toMatch(/Snapshots are saved manually: press Snapshot in the Studio/);
    expect(t).toMatch(/A session you don't snapshot leaves nothing in History/);
    expect(t).toMatch(/Live sessions themselves aren't stored here/);
  });
  it("an empty filtered result says the filters matched nothing, not that nothing was ever saved", async () => {
    const t = text(await page({ type: "outfit" }));
    expect(t).toContain("No saved items match these filters.");
    expect(t).not.toContain("Nothing saved yet.");
  });
  it("shows the full prompt on each saved item, and only the user's own", async () => {
    const long = "Turn me into a weathered sea captain with a grey beard, a storm behind me and rain on the lens, cinematic and moody lighting";
    await d.insert(transformations).values([
      { userId: "A", title: long.slice(0, 60), prompt: long, type: "custom" },
      { userId: "B", title: "bobclip", prompt: "bob's private prompt", type: "custom" },
    ]);
    const t = text(await page());
    expect(t).toContain(long);
    expect(t).not.toContain("bobclip");
    expect(t).not.toContain("bob's private prompt");
  });
  it("an item with no prompt has no empty prompt toggle", async () => {
    await d.insert(transformations).values({ userId: "A", title: "Snapshot", prompt: "" });
    expect(html(await page())).not.toContain("<summary");
  });
});
