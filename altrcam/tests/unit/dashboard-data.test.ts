/**
 * What the dashboard reads: usage numbers, presets, last payment, subscription flag and usage history,
 * against a real in-memory Postgres. Cross-account leakage is covered in isolation.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, payments, presets, studioSessions, subscriptions, transformations, users } from "@/db/schema";
import { grantCredits } from "@/lib/credits";
import { setPlanConfig } from "@/lib/plan-config";
import { DEFAULT_PLANS } from "@/lib/plans";
import { dashboardData, usageHistory } from "@/lib/queries";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, studio_sessions, transformations, presets, support_tickets, plan_config restart identity cascade`);
  await d.insert(users).values([{ id: "U", email: "u@x.co", name: "U" }, { id: "O", email: "o@x.co", name: "O" }]);
});

const spend = (userId: string, n: number, bucket: "monthly" | "purchased", at = new Date()) =>
  d.insert(creditLedger).values({ userId, delta: -n, bucket, reason: "session", createdAt: at });
const lastMonth = () => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 15)); };

describe("dashboardData: usage and allowance", () => {
  it("a plan with a zero monthly allowance gives no percentage (never NaN) and is out of credits at a zero balance", async () => {
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 }, "admin");
    const out = await dashboardData("U", "FREE", d);
    expect(out.allowance).toBe(0);
    expect(out.usagePct).toBeNull();
    expect(Number.isNaN(out.usagePct)).toBe(false);
    expect(out.lowCredits).toBe(true); // balance 0
  });
  it("a zero allowance with purchased credits left is not 'low'", async () => {
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 }, "admin");
    await grantCredits(d, "U", 500, "purchased", "topup_purchase");
    const out = await dashboardData("U", "FREE", d);
    expect(out.usagePct).toBeNull();
    expect(out.lowCredits).toBe(false);
    await spend("U", 500, "purchased");
    expect((await dashboardData("U", "FREE", d)).lowCredits).toBe(true);
  });
  it("measures the monthly allowance by monthly-bucket spending only, and reports total spending separately", async () => {
    await grantCredits(d, "U", 300, "monthly", "signup_grant");
    await grantCredits(d, "U", 1000, "purchased", "topup_purchase");
    await spend("U", 100, "monthly");
    await spend("U", 40, "purchased");
    const out = await dashboardData("U", "FREE", d);
    expect(out.allowance).toBe(300);
    expect(out.usedMonthly).toBe(100);
    expect(out.usedSeconds).toBe(140);
    expect(out.usagePct).toBe(33);
  });
  it("ignores spending from earlier months and non-session ledger rows", async () => {
    await grantCredits(d, "U", 300, "monthly", "signup_grant");
    await spend("U", 250, "monthly", lastMonth());
    await d.insert(creditLedger).values({ userId: "U", delta: -20, bucket: "monthly", reason: "monthly_expiry" });
    const out = await dashboardData("U", "FREE", d);
    expect(out.usedMonthly).toBe(0);
    expect(out.usedSeconds).toBe(0);
    expect(out.usagePct).toBe(0);
  });
  it("flags low credits under 10% of the allowance and not above", async () => {
    await grantCredits(d, "U", 29, "monthly", "g");
    expect((await dashboardData("U", "FREE", d)).lowCredits).toBe(true);
    await grantCredits(d, "U", 1, "monthly", "g");
    expect((await dashboardData("U", "FREE", d)).lowCredits).toBe(false);
  });
  it("counts this month's sessions only", async () => {
    await d.insert(studioSessions).values([
      { id: "00000000-0000-4000-8000-000000000001", userId: "U", maxSeconds: 120 },
      { id: "00000000-0000-4000-8000-000000000002", userId: "U", maxSeconds: 120, startedAt: lastMonth() },
    ]);
    expect((await dashboardData("U", "FREE", d)).sessionsThisMonth).toBe(1);
  });
});

describe("dashboardData: presets, payment and subscription", () => {
  it("returns the four newest presets, the total count and nothing else", async () => {
    for (let i = 1; i <= 6; i++) await d.insert(presets).values({ userId: "U", name: `p${i}`, kind: "prompt", prompt: "secret prompt", createdAt: new Date(Date.UTC(2026, 0, i)) });
    const out = await dashboardData("U", "FREE", d);
    expect(out.presetCount).toBe(6);
    expect(out.presets.map((p) => p.name)).toEqual(["p6", "p5", "p4", "p3"]);
    expect(Object.keys(out.presets[0]).sort()).toEqual(["id", "kind", "name"]);
  });
  it("last payment is the newest successful one, not a pending or rejected attempt", async () => {
    const row = (reference: string, status: string, at: number, amountMinor = 1000) =>
      ({ userId: "U", provider: "paystack", reference, kind: "topup" as const, product: "TOPUP_1K", amountMinor, currency: "NGN", status, createdAt: new Date(Date.UTC(2026, 0, at)) });
    await d.insert(payments).values([row("old", "success", 1, 1000), row("new", "success", 3, 3000), row("later-pending", "pending", 5), row("later-rejected", "rejected", 6)]);
    const out = await dashboardData("U", "FREE", d);
    expect(out.lastPayment).toMatchObject({ product: "TOPUP_1K", amountMinor: 3000, currency: "NGN" });
  });
  it("has no last payment for someone who never paid", async () => {
    expect((await dashboardData("U", "FREE", d)).lastPayment).toBeNull();
  });
  it("knows whether there is an active subscription on record; a cancelled one does not count", async () => {
    expect((await dashboardData("U", "PRO", d)).hasActiveSubscription).toBe(false);
    await d.insert(subscriptions).values({ userId: "U", provider: "paystack", providerSubId: "S1", plan: "PRO", status: "cancelled" });
    expect((await dashboardData("U", "PRO", d)).hasActiveSubscription).toBe(false);
    await d.insert(subscriptions).values({ userId: "U", provider: "paystack", providerSubId: "S2", plan: "PRO", status: "active" });
    expect((await dashboardData("U", "PRO", d)).hasActiveSubscription).toBe(true);
  });
  it("still returns the six most recent transformations", async () => {
    for (let i = 1; i <= 8; i++) await d.insert(transformations).values({ userId: "U", title: `t${i}`, createdAt: new Date(Date.UTC(2026, 0, i)) });
    expect((await dashboardData("U", "FREE", d)).recent.map((t) => t.title)).toEqual(["t8", "t7", "t6", "t5", "t4", "t3"]);
  });
});

describe("usageHistory", () => {
  it("lists sessions newest first with date, billed seconds, end reason and the prompt, capped at the limit", async () => {
    for (let i = 1; i <= 10; i++) {
      await d.insert(studioSessions).values({
        id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`, userId: "U", maxSeconds: 120, secondsBilled: i * 10,
        startedAt: new Date(Date.UTC(2026, 0, i)), endedAt: new Date(Date.UTC(2026, 0, i, 0, 5)), endReason: i === 10 ? "credits" : "user",
        settings: { prompt: `prompt ${i}`, expand: true, kind: "prompt" },
      });
    }
    const out = await usageHistory("U", d);
    expect(out.sessions).toHaveLength(8);
    expect(out.sessions[0]).toMatchObject({ secondsBilled: 100, endReason: "credits", prompt: "prompt 10" });
    expect(out.sessions.map((s) => s.secondsBilled)).toEqual([100, 90, 80, 70, 60, 50, 40, 30]);
    expect((await usageHistory("U", d, 3)).sessions).toHaveLength(3);
  });
  it("copes with sessions that have no settings, odd settings or are still open", async () => {
    await d.insert(studioSessions).values([
      { id: "00000000-0000-4000-8000-000000000001", userId: "U", maxSeconds: 120, startedAt: new Date(Date.UTC(2026, 0, 1)) },
      { id: "00000000-0000-4000-8000-000000000002", userId: "U", maxSeconds: 120, startedAt: new Date(Date.UTC(2026, 0, 2)), settings: { prompt: 42 } },
      { id: "00000000-0000-4000-8000-000000000003", userId: "U", maxSeconds: 120, startedAt: new Date(Date.UTC(2026, 0, 3)), settings: { prompt: "x".repeat(500) } },
    ]);
    const out = await usageHistory("U", d);
    expect(out.sessions[0].prompt).toHaveLength(120); // long prompts are cut
    expect(out.sessions[1].prompt).toBeNull();
    expect(out.sessions[2]).toMatchObject({ prompt: null, endedAt: null, endReason: null });
  });
  it("cuts a long prompt by characters, never through the middle of an emoji, and returns the last heartbeat", async () => {
    const beat = new Date(Date.UTC(2026, 0, 3, 10, 0, 0));
    await d.insert(studioSessions).values({
      id: "00000000-0000-4000-8000-0000000000a1", userId: "U", maxSeconds: 120, startedAt: new Date(Date.UTC(2026, 0, 3)), lastHeartbeatAt: beat,
      settings: { prompt: "😀".repeat(200) },
    });
    const [s] = (await usageHistory("U", d)).sessions;
    expect([...s.prompt!]).toHaveLength(120);
    expect(s.prompt).toBe("😀".repeat(120)); // a UTF-16 slice(0, 120) would have given 60 emoji, or split one
    expect(s.prompt).not.toMatch(/\uFFFD/);
    expect(s.lastHeartbeatAt.getTime()).toBe(beat.getTime());
  });
  it("does not hand the whole settings object to the page", async () => {
    await d.insert(studioSessions).values({
      id: "00000000-0000-4000-8000-0000000000a2", userId: "U", maxSeconds: 120, settings: { prompt: "p", referencePath: "U/secret.png", blob: "x".repeat(10_000) },
    });
    const [s] = (await usageHistory("U", d)).sessions;
    expect(Object.keys(s)).not.toContain("settings");
    expect(JSON.stringify(s)).not.toContain("secret.png");
  });
  it("credit activity leaves out the per-heartbeat session debits so grants and top-ups stay visible", async () => {
    await grantCredits(d, "U", 300, "monthly", "signup_grant");
    for (let i = 0; i < 20; i++) await spend("U", 10, "monthly", new Date(Date.now() - i * 1000));
    await grantCredits(d, "U", 1000, "purchased", "topup_purchase");
    const out = await usageHistory("U", d);
    expect(out.credits.map((c) => c.reason).sort()).toEqual(["signup_grant", "topup_purchase"]);
    expect(out.credits[0]).toMatchObject({ reason: "topup_purchase", delta: 1000, bucket: "purchased" });
  });
  it("returns empty lists for a user with no activity", async () => {
    expect(await usageHistory("U", d)).toEqual({ sessions: [], credits: [] });
  });
});
