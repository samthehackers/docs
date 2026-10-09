/** Pure helpers behind the dashboard: usage maths, status wording, labels. No database. */
import { describe, expect, it } from "vitest";
import {
  fmtDate, fmtDuration, fmtMonthYear, fmtSessionLimit, initials, isLowCredit, ledgerReasonLabel, planComparison, planStatusView, sessionEndLabel, usagePercent,
} from "@/lib/account-summary";
import { DEFAULT_PLANS, STALE_AFTER_SECONDS } from "@/lib/plans";

const NOW = new Date("2026-03-10T12:00:00Z");
const END = new Date("2026-03-20T00:00:00Z");
const FUTURE = "Mar 20, 2026";

describe("usagePercent", () => {
  it("is a rounded percentage of the allowance, capped at 100", () => {
    expect(usagePercent(0, 300)).toBe(0);
    expect(usagePercent(100, 300)).toBe(33);
    expect(usagePercent(300, 300)).toBe(100);
    expect(usagePercent(450, 300)).toBe(100);
  });
  it("is null (no meter) when the plan has no monthly allowance, instead of NaN or Infinity", () => {
    expect(usagePercent(0, 0)).toBeNull();
    expect(usagePercent(120, 0)).toBeNull();
  });
  it("never goes negative", () => {
    expect(usagePercent(-5, 300)).toBe(0);
  });
});

describe("isLowCredit", () => {
  it("is low under 10% of the allowance and not at the boundary", () => {
    expect(isLowCredit(29, 300)).toBe(true);
    expect(isLowCredit(30, 300)).toBe(false);
    expect(isLowCredit(250, 300)).toBe(false);
  });
  it("treats an empty balance as low even when the allowance is zero", () => {
    expect(isLowCredit(0, 0)).toBe(true);
    expect(isLowCredit(0, 300)).toBe(true);
  });
  it("does not flag a positive balance on a plan with no monthly allowance", () => {
    expect(isLowCredit(5, 0)).toBe(false);
  });
});

describe("formatting", () => {
  it("formats dates in UTC so the server's time zone does not shift them", () => {
    expect(fmtDate(new Date("2026-03-20T23:59:59Z"))).toBe("Mar 20, 2026");
  });
  it("formats member-since as month and year", () => {
    expect(fmtMonthYear(new Date("2026-03-31T23:59:59Z"))).toBe("March 2026");
  });
  it.each([["Ada Lovelace", "a@x.co", "AL"], ["ada", "a@x.co", "AD"], ["Mary Jane Watson", "a@x.co", "MW"], ["", "zed@x.co", "Z"], ["  ", "", "?"]])("initials %j / %j -> %s", (name, email, out) => {
    expect(initials(name, email)).toBe(out);
  });
  it.each([[0, "0s"], [45, "45s"], [60, "1m"], [125, "2m 05s"], [3600, "1h"], [3725, "1h 2m"], [-3, "0s"]])("duration %s -> %s", (s, out) => {
    expect(fmtDuration(s)).toBe(out);
  });
  it.each([[30, "30 sec"], [120, "2 min"], [1800, "30 min"], [90, "1 min 30 sec"]])("session limit %s -> %s", (s, out) => {
    expect(fmtSessionLimit(s)).toBe(out);
  });
});

describe("ledgerReasonLabel", () => {
  it("names every reason the app writes, in plain words", () => {
    for (const r of ["signup_grant", "monthly_refill", "monthly_expiry", "topup_purchase", "referral_reward", "admin_grant", "admin_revoke", "session"]) {
      expect(ledgerReasonLabel(r)).not.toBe(ledgerReasonLabel("something_else"));
      expect(ledgerReasonLabel(r)).not.toContain("_");
    }
  });
  it("does not echo an unknown reason string back to the user", () => {
    expect(ledgerReasonLabel("fixed by Bob, ticket 123")).toBe("Other credit change");
  });
});

describe("sessionEndLabel", () => {
  it("explains each way a session ends", () => {
    expect(sessionEndLabel("credits")).toMatch(/out of credits/i);
    expect(sessionEndLabel("session_limit")).toMatch(/session limit/i);
    expect(sessionEndLabel("user")).toMatch(/you/i);
    expect(sessionEndLabel("stale")).toMatch(/connection|checking in/i);
    expect(sessionEndLabel("superseded")).toMatch(/newer session/i);
  });
  it("says a session without an end is still open, and tolerates unknown reasons", () => {
    expect(sessionEndLabel(null)).toMatch(/still open/i);
    expect(sessionEndLabel("whatever")).toBe("Ended");
  });
  it("does not call a silent session 'still open': it stopped checking in", () => {
    const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);
    expect(sessionEndLabel(null, secondsAgo(5), NOW)).toBe("Still open");
    expect(sessionEndLabel(null, secondsAgo(STALE_AFTER_SECONDS - 1), NOW)).toBe("Still open");
    expect(sessionEndLabel(null, secondsAgo(STALE_AFTER_SECONDS + 1), NOW)).toMatch(/stopped checking in.*closed automatically/i);
    expect(sessionEndLabel(null, secondsAgo(86_400), NOW)).toMatch(/stopped checking in/i);
  });
  it("a heartbeat only matters for sessions that have not ended", () => {
    expect(sessionEndLabel("user", new Date(0), NOW)).toBe("Ended by you");
  });
});

describe("planStatusView", () => {
  const pro = { plan: "PRO" as const, planStatus: "active", planRenewsAt: END };
  it("active Pro with a subscription renews on the date", () => {
    const v = planStatusView(pro, true, NOW);
    expect(v).toMatchObject({ label: "Active", tone: "ok", alert: null });
    expect(v.detail).toBe(`Renews ${FUTURE}`);
  });
  it("active Pro with no subscription on record says it will not renew, and does not claim it renews", () => {
    const v = planStatusView(pro, false, NOW);
    expect(v.label).toBe("Not renewing");
    expect(v.detail).toContain(FUTURE);
    expect(v.detail).not.toMatch(/^Renews/);
  });
  it("cancelling shows the end date", () => {
    const v = planStatusView({ ...pro, planStatus: "cancelling" }, false, NOW);
    expect(v.label).toBe("Cancelled");
    expect(v.detail).toBe(`Pro stays active until ${FUTURE}.`);
    expect(v.alert).toBeNull();
  });
  it("past_due carries a clear warning that names the date and points to billing", () => {
    const v = planStatusView({ ...pro, planStatus: "past_due" }, true, NOW);
    expect(v.tone).toBe("warn");
    expect(v.label).toBe("Payment failed");
    expect(v.alert).toMatch(/renewal payment failed/i);
    expect(v.alert).toContain(FUTURE);
    expect(v.alert).toMatch(/free/i);
  });
  it("past_due after the paid period ended does not promise a future date", () => {
    const v = planStatusView({ ...pro, planStatus: "past_due", planRenewsAt: new Date("2026-03-09T00:00:00Z") }, true, NOW);
    expect(v.alert).toMatch(/renewal payment failed/i);
    expect(v.alert).not.toMatch(/Mar \d/);
    expect(v.detail).toBe("Paid period ended Mar 9, 2026");
  });
  it("past_due without a date still warns", () => {
    expect(planStatusView({ ...pro, planStatus: "past_due", planRenewsAt: null }, true, NOW).alert).toMatch(/renewal payment failed/i);
  });
  it("an expired plan says Pro ended and purchased credits are kept", () => {
    const v = planStatusView({ plan: "FREE", planStatus: "expired", planRenewsAt: null }, false, NOW);
    expect(v.label).toBe("Pro ended");
    expect(v.detail).toMatch(/free/i);
    expect(v.detail).toMatch(/purchased credits are kept/i);
  });
  it("Free has no subscription, and the badge does not repeat the plan name", () => {
    const v = planStatusView({ plan: "FREE", planStatus: "active", planRenewsAt: null }, false, NOW);
    expect(v).toMatchObject({ label: "No subscription", detail: null, tone: "ok", alert: null });
  });
  it("Lifetime has no renewal, and the badge does not repeat the plan name", () => {
    const v = planStatusView({ plan: "LIFETIME", planStatus: "active", planRenewsAt: null }, false, NOW);
    expect(v.label).toBe("Never expires");
    expect(v.label).not.toBe("Lifetime");
    expect(v.detail).toMatch(/no renewal/i);
  });
  describe("a renewal date that has already passed (late webhook, daily downgrade not run yet)", () => {
    const past = new Date("2026-03-09T00:00:00Z"), PAST = "Mar 9, 2026";
    it("an active subscriber is not told it renews in the past", () => {
      const v = planStatusView({ ...pro, planRenewsAt: past }, true, NOW);
      expect(v.detail).toBe(`Renewal was due ${PAST}; waiting for the payment to be confirmed.`);
      expect(v.detail).not.toMatch(/^Renews/);
      expect(v.alert).toBeNull();
    });
    it("a cancelling user is not told Pro stays active until a past date", () => {
      const v = planStatusView({ ...pro, planStatus: "cancelling", planRenewsAt: past }, false, NOW);
      expect(v.detail).toBe(`Pro ended ${PAST}; your plan is switching to Free shortly.`);
      expect(v.detail).not.toMatch(/stays active/);
    });
    it("a Pro plan with no subscription on record and a past date says it ended", () => {
      const v = planStatusView({ ...pro, planRenewsAt: past }, false, NOW);
      expect(v.label).toBe("Not renewing");
      expect(v.detail).toBe(`Pro ended ${PAST}; your plan is switching to Free shortly.`);
    });
    it("future dates are unchanged", () => {
      expect(planStatusView(pro, true, NOW).detail).toBe(`Renews ${FUTURE}`);
      expect(planStatusView({ ...pro, planStatus: "cancelling" }, false, NOW).detail).toBe(`Pro stays active until ${FUTURE}.`);
    });
  });
  it("shows an unexpected status as-is instead of hiding it", () => {
    expect(planStatusView({ ...pro, planStatus: "paused" }, true, NOW).label).toBe("Paused");
  });
});

describe("planComparison", () => {
  it("reads every row from the plan config it is given", () => {
    const rows = planComparison(DEFAULT_PLANS.FREE, DEFAULT_PLANS.PRO);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Credits per month"]).toMatchObject({ free: "300", pro: "6,000" });
    expect(by["Longest session"]).toMatchObject({ free: "2 min", pro: "30 min" });
    expect(by["Camera capture"]).toMatchObject({ free: "640×360", pro: "1280×720" });
    expect(by["Resolution"]).toBeUndefined();
    expect(by["Saved presets"]).toMatchObject({ free: "3", pro: "100" });
    expect(by["History kept"]).toMatchObject({ free: "7 days", pro: "365 days" });
    expect(by["Clip recording"]).toMatchObject({ free: "No", pro: "Yes" });
  });
  it("follows admin overrides rather than the code defaults", () => {
    const rows = planComparison({ ...DEFAULT_PLANS.FREE, monthlyCredits: 0, historyDays: null }, { ...DEFAULT_PLANS.PRO, monthlyCredits: 9000, maxSessionSeconds: 3600 });
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Credits per month"]).toMatchObject({ free: "0", pro: "9,000" });
    expect(by["History kept"].free).toBe("No expiry");
    expect(by["Longest session"].pro).toBe("60 min");
  });
});
