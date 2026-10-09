import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, planConfig, users } from "@/db/schema";
import { getPlan, getPlans, PlanInput, resetPlanConfig, setPlanConfig } from "@/lib/plan-config";
import { DEFAULT_PLANS } from "@/lib/plans";
import { fulfilPayment } from "@/lib/payments/fulfil";
import { ledgerBalance, grantCredits, resetMonthly } from "@/lib/credits";
import { provisionUser } from "@/lib/users";

let d: DB;
beforeAll(async () => { d = await testDb(); }, 60_000);
beforeEach(async () => {
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, plan_config restart identity cascade`);
});

const pro = { monthlyCredits: 9000, maxSessionSeconds: 3600, maxResolution: "high" as const, presets: 50, historyDays: 90, clipRecording: true };

describe("effective plan limits", () => {
  it("are the code defaults when nothing is overridden", async () => {
    expect(await getPlans(d)).toEqual(DEFAULT_PLANS);
  });
  it("merge an admin override over the defaults, per plan, keeping labels", async () => {
    await setPlanConfig(d, "PRO", pro, "admin1");
    const p = await getPlans(d);
    expect(p.PRO).toMatchObject({ ...pro, label: "Pro" });
    expect(p.FREE).toEqual(DEFAULT_PLANS.FREE);
  });
  it("support 'keep forever' (null history) and reset back to defaults", async () => {
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, historyDays: null }, "admin1");
    expect((await getPlan("FREE", d)).historyDays).toBeNull();
    await resetPlanConfig(d, "FREE", "admin1");
    expect(await getPlan("FREE", d)).toEqual(DEFAULT_PLANS.FREE);
  });
  it("write an audit entry with before and after", async () => {
    await setPlanConfig(d, "PRO", pro, "admin1");
    const [a] = await d.select().from(auditLog).where(eq(auditLog.action, "plan_config.update"));
    expect(a).toMatchObject({ actorId: "admin1", target: "PRO" });
    expect(a.meta).toMatchObject({ before: { monthlyCredits: 6000 }, after: { monthlyCredits: 9000 } });
    await resetPlanConfig(d, "PRO", "admin2");
    expect((await d.select().from(auditLog).where(eq(auditLog.action, "plan_config.reset"))).length).toBe(1);
  });
  it("fall back to defaults instead of throwing when the database fails", async () => {
    const broken = { select: () => { throw new Error("connection refused"); } } as unknown as DB;
    expect(await getPlans(broken)).toEqual(DEFAULT_PLANS);
  });
});

describe("validation", () => {
  it.each([
    ["negative credits", { ...pro, monthlyCredits: -1 }],
    ["absurd credits", { ...pro, monthlyCredits: 5_000_000 }],
    ["too-short session", { ...pro, maxSessionSeconds: 1 }],
    ["fractional presets", { ...pro, presets: 1.5 }],
    ["zero history days", { ...pro, historyDays: 0 }],
    ["unknown resolution", { ...pro, maxResolution: "4k" }],
    ["string credits", { ...pro, monthlyCredits: "9000" }],
    ["missing field", { monthlyCredits: 1 }],
  ])("rejects %s", async (_n, bad) => {
    expect(PlanInput.safeParse(bad).success).toBe(false);
    await expect(setPlanConfig(d, "PRO", bad, "admin1")).rejects.toThrow();
    expect((await d.select().from(planConfig)).length).toBe(0);
  });
  it("the database itself refuses out-of-range rows (defence in depth)", async () => {
    await expect(d.insert(planConfig).values({ plan: "PRO", ...pro, monthlyCredits: -5, updatedBy: "x" })).rejects.toThrow();
    await expect(d.insert(planConfig).values({ plan: "PRO", ...pro, maxResolution: "8k", updatedBy: "x" })).rejects.toThrow();
  });
});

describe("limits are actually used", () => {
  beforeEach(async () => { await d.insert(users).values({ id: "u1", email: "a@b.co", name: "A" }); });
  const buy = { provider: "paystack" as const, eventId: "e1", eventType: "charge.success", payload: {}, reference: "r1", userId: "u1", product: "PRO_MONTHLY" as const, amountMinor: 1500000, currency: "NGN" };

  it("a Pro purchase grants the configured allowance, not the hard-coded one", async () => {
    await setPlanConfig(d, "PRO", pro, "admin1");
    await fulfilPayment(buy, d);
    expect((await ledgerBalance(d, "u1")).monthly).toBe(9000);
  });
  it("a zero allowance grants nothing and does NOT roll back the payment", async () => {
    await setPlanConfig(d, "PRO", { ...pro, monthlyCredits: 0 }, "admin1");
    expect(await fulfilPayment(buy, d)).toBe("applied");
    const [u] = await d.select().from(users).where(eq(users.id, "u1"));
    expect(u.plan).toBe("PRO");
    expect((await ledgerBalance(d, "u1")).total).toBe(0);
  });
  it("monthly reset with a zero allowance expires old credits and grants none", async () => {
    await grantCredits(d, "u1", 50, "monthly", "g");
    await d.transaction((tx) => resetMonthly(tx, "u1", 0, "2025-03"));
    expect(await ledgerBalance(d, "u1")).toMatchObject({ monthly: 0 });
  });
  it("signup uses the configured FREE allowance", async () => {
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 77 }, "admin1");
    await provisionUser({ id: "new1", email: "n@x.co", name: "N" }, d);
    expect((await ledgerBalance(d, "new1")).monthly).toBe(77);
  });
  it("signup with a zero FREE allowance still creates the account", async () => {
    await setPlanConfig(d, "FREE", { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 }, "admin1");
    expect(await provisionUser({ id: "new2", email: "n2@x.co", name: "N" }, d)).toBe(true);
    expect((await ledgerBalance(d, "new2")).total).toBe(0);
  });
});
