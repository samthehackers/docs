/**
 * Pure helpers behind the public pages' wording: plan feature lines, the "saving" sentence, the billing details,
 * and the one place the live-video status is written down.
 */
import { describe, expect, it } from "vitest";
import { billingDetails, clipPlanLabels, freeCreditsLine, joinList, PAYMENT_METHODS_TEXT, planFeatures, savingSentence, SIGNUP_CLOSED } from "@/lib/public-copy";
import { CAPTURE_SIZE, DEFAULT_PLANS, type Plan, type PlanConfig } from "@/lib/plans";
import { LIVE_AVAILABILITY } from "@/lib/availability";

const plans = (over: Partial<Record<Plan, Partial<PlanConfig>>> = {}): Record<Plan, PlanConfig> => ({
  FREE: { ...DEFAULT_PLANS.FREE, ...over.FREE }, PRO: { ...DEFAULT_PLANS.PRO, ...over.PRO }, LIFETIME: { ...DEFAULT_PLANS.LIFETIME, ...over.LIFETIME },
});

describe("joinList", () => {
  it("reads like a sentence", () => {
    expect(joinList([])).toBe("");
    expect(joinList(["Pro"])).toBe("Pro");
    expect(joinList(["Pro", "Lifetime"])).toBe("Pro and Lifetime");
    expect(joinList(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("plan feature lines", () => {
  it("describe the camera capture size, not an output quality", () => {
    const free = planFeatures(DEFAULT_PLANS.FREE).join(" | ");
    const pro = planFeatures(DEFAULT_PLANS.PRO).join(" | ");
    expect(free).toContain("Camera feed requested at 640×360");
    expect(pro).toContain("Camera feed requested at 1280×720");
    for (const line of [free, pro]) expect(line).not.toMatch(/\bresolution\b|High|Standard/);
  });
  it("uses the same sizes the Studio asks the camera for", () => {
    expect(CAPTURE_SIZE).toEqual({ low: { width: 640, height: 360 }, high: { width: 1280, height: 720 } });
  });
  it("states limits from the plan config, including admin overrides", () => {
    const f = planFeatures({ ...DEFAULT_PLANS.PRO, monthlyCredits: 12345, maxSessionSeconds: 600, presets: 7, historyDays: 30 });
    expect(f).toContain("12,345 credits every month");
    expect(f).toContain("Sessions up to 10 min");
    expect(f).toContain("7 saved presets");
    expect(f).toContain("30-day history");
  });
  it("says what happens with snapshots and clips, per plan", () => {
    expect(planFeatures(DEFAULT_PLANS.FREE)).toContain("Snapshots (no clip recording)");
    expect(planFeatures(DEFAULT_PLANS.PRO)).toContain("Snapshots and clip recording");
  });
  it("does not round an admin-set session length up: 150 s is 2 min 30 sec, 45 s is 45 sec", () => {
    const len = (s: number) => planFeatures({ ...DEFAULT_PLANS.PRO, maxSessionSeconds: s }).find((l) => l.startsWith("Sessions up to"));
    expect(len(150)).toBe("Sessions up to 2 min 30 sec");
    expect(len(45)).toBe("Sessions up to 45 sec");
    expect(len(20)).toBe("Sessions up to 20 sec");
    expect(len(1800)).toBe("Sessions up to 30 min");
  });
  it("does not promise 'forever' for unlimited history", () => {
    expect(planFeatures(DEFAULT_PLANS.LIFETIME).join(" ")).not.toMatch(/forever/i);
    expect(planFeatures(DEFAULT_PLANS.LIFETIME)).toContain("No history expiry");
  });
});

describe("the sentence about saving", () => {
  it("names the plans that include clips today, and says snapshots are on every plan", () => {
    expect(clipPlanLabels(plans())).toEqual(["Pro", "Lifetime"]);
    expect(savingSentence(plans())).toBe("Save snapshots to your History on every plan. Recording a clip to download is included in Pro and Lifetime.");
  });
  it("follows the admin: no hard-coded 'Pro'", () => {
    expect(savingSentence(plans({ LIFETIME: { clipRecording: false } }))).toContain("included in Pro.");
    expect(savingSentence(plans({ FREE: { clipRecording: true } }))).toContain("Free, Pro and Lifetime");
  });
  it("is honest when no plan has clips", () => {
    const none = plans({ PRO: { clipRecording: false }, LIFETIME: { clipRecording: false } });
    expect(savingSentence(none)).toBe("Save snapshots to your History on every plan. Clip recording isn't included in any plan right now.");
  });
});

describe("billing details", () => {
  const base = { currency: "NGN", yearlyPrice: "₦150,000", pricesApproved: false };
  const all = (d: ReturnType<typeof billingDetails>) => d.map((x) => `${x.term}: ${x.text}`).join("\n");
  it("covers credits, renewal, cancelling, currency, payment methods, top-ups, Lifetime and refunds", () => {
    const d = billingDetails(base);
    expect(d.map((x) => x.term)).toEqual(["Credits", "Renewal", "Cancelling", "Currency", "Payment methods", "Top-ups", "Lifetime", "Refunds"]);
    expect(d[0].text).toBe("1 credit = 1 second of live transformed video. Credits count only while your transformed video is live. If it never connects, you pay nothing.");
    const t = all(d);
    expect(t).toContain("renews automatically");
    expect(t).toContain("A Pro subscription can be cancelled from the Billing page");
    expect(t).toContain("end of the period you already paid for");
    expect(t).toContain("nothing to cancel");
    expect(t).toContain("Card prices are shown and charged in NGN");
    expect(t).toContain("Crypto amounts are quoted at checkout");
    expect(t).toContain("never expire");
    expect(t).toContain("non-refundable except where the law requires otherwise");
    expect(d.find((x) => x.term === "Refunds")?.links?.map((l) => l.href)).toEqual(["/terms", "/contact"]);
  });
  it("says crypto is for Lifetime and top-ups only, never for Pro, and does not promise which card methods exist", () => {
    const methods = billingDetails(base).find((x) => x.term === "Payment methods")!.text;
    expect(methods).toBe(PAYMENT_METHODS_TEXT);
    expect(methods).toMatch(/Pro subscriptions are paid through Paystack/);
    expect(methods).toMatch(/up to Paystack/);
    expect(methods).toMatch(/Lifetime and top-ups can be paid through Paystack or with cryptocurrency/);
    expect(methods).not.toMatch(/Pro[^.]*crypto/i);
  });
  it("mentions the yearly option only when it has a price", () => {
    expect(all(billingDetails(base))).toContain("yearly subscription for ₦150,000");
    const none = all(billingDetails({ ...base, yearlyPrice: "TBA" }));
    expect(none).not.toMatch(/yearly|TBA/i);
  });
  it("refers to prices not being final only while they are not approved, so the text never points at a notice that is gone", () => {
    expect(all(billingDetails(base))).toContain("These amounts are not final yet.");
    const approved = all(billingDetails({ ...base, pricesApproved: true }));
    expect(approved).not.toMatch(/not final|pricing notice/i);
  });
  it("shows the configured currency", () => {
    expect(all(billingDetails({ ...base, currency: "USD", yearlyPrice: "TBA" }))).toContain("charged in USD");
  });
  it("is honest that Lifetime is not defined yet", () => {
    expect(billingDetails(base).find((x) => x.term === "Lifetime")!.text).toMatch(/do not yet say how long/);
  });
});

describe("the live-video status", () => {
  it("says it is untested, and that credits count only while the transformed video is live", () => {
    const t = `${LIVE_AVAILABILITY.title} ${LIVE_AVAILABILITY.body}`;
    expect(t).toMatch(/hasn't been tested end to end/);
    expect(t).toMatch(/may not connect/);
    expect(t).toContain("Credits count only while your transformed video is live. If it never connects, you pay nothing.");
    expect(t).not.toMatch(/even if the connection fails/);
  });
  it("does not name the model vendor in public body copy", () => {
    expect(`${LIVE_AVAILABILITY.title} ${LIVE_AVAILABILITY.body}`).not.toMatch(/Decart|Lucy|fal\.ai/i);
  });
});

describe("the free-credits line", () => {
  it("says 'every month' only when the refill job can run", () => {
    expect(freeCreditsLine(300, true)).toBe("300 free credits every month. No card needed.");
    expect(freeCreditsLine(300, false)).toBe("300 free credits when you sign up. No card needed.");
  });
  it("is absent when the Free plan grants nothing, never '0 free credits'", () => {
    expect(freeCreditsLine(0, true)).toBeNull();
    expect(freeCreditsLine(0, false)).toBeNull();
    expect(freeCreditsLine(-5, true)).toBeNull();
    expect(freeCreditsLine(Number.NaN, true)).toBeNull();
  });
  it("formats thousands", () => {
    expect(freeCreditsLine(1500, true)).toBe("1,500 free credits every month. No card needed.");
  });
  it("the closed-sign-up sentence is the one the pages and the tests agree on", () => {
    expect(SIGNUP_CLOSED).toBe("Sign-up isn't open on this deployment yet.");
  });
});

