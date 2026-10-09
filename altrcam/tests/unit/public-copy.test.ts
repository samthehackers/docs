/**
 * Pure helpers behind the public pages' wording: plan feature lines, the "saving" sentence, the billing details,
 * and the one place the live-video status is written down.
 */
import { describe, expect, it } from "vitest";
import { billingDetails, clipPlanLabels, joinList, planFeatures, savingSentence } from "@/lib/public-copy";
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
    expect(free).toContain("Camera captured at up to 640×360");
    expect(pro).toContain("Camera captured at up to 1280×720");
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
  const all = (d: ReturnType<typeof billingDetails>) => d.map((x) => `${x.term}: ${x.text}`).join("\n");
  it("covers renewal, cancelling, currency, payment methods, top-ups and refunds", () => {
    const d = billingDetails({ currency: "NGN", yearlyPrice: "₦150,000" });
    expect(d.map((x) => x.term)).toEqual(["Renewal", "Cancelling", "Currency", "Payment methods", "Top-ups", "Refunds"]);
    const t = all(d);
    expect(t).toContain("renews automatically");
    expect(t).toContain("Cancel any time");
    expect(t).toContain("end of the period you already paid for");
    expect(t).toContain("charged in NGN");
    expect(t).toContain("Paystack");
    expect(t).toContain("cryptocurrency through NOWPayments");
    expect(t).toContain("never expire");
    expect(t).toContain("non-refundable except where the law requires otherwise");
    expect(d.find((x) => x.term === "Refunds")?.links?.map((l) => l.href)).toEqual(["/terms", "/contact"]);
  });
  it("says crypto is for Lifetime and top-ups only, never for Pro", () => {
    const methods = billingDetails({ currency: "NGN", yearlyPrice: "TBA" }).find((x) => x.term === "Payment methods")!.text;
    expect(methods).toMatch(/Pro subscriptions are paid through Paystack/);
    expect(methods).toMatch(/Lifetime and top-ups can be paid through Paystack or with cryptocurrency/);
  });
  it("mentions the yearly option only when it has a price", () => {
    expect(all(billingDetails({ currency: "NGN", yearlyPrice: "₦150,000" }))).toContain("yearly subscription for ₦150,000");
    const none = all(billingDetails({ currency: "NGN", yearlyPrice: "TBA" }));
    expect(none).not.toMatch(/yearly|TBA/i);
  });
  it("shows the configured currency", () => {
    expect(all(billingDetails({ currency: "USD", yearlyPrice: "TBA" }))).toContain("charged in USD");
  });
});

describe("the live-video status", () => {
  it("says it is untested and that credits count even if the connection fails", () => {
    const t = `${LIVE_AVAILABILITY.title} ${LIVE_AVAILABILITY.body}`;
    expect(t).toMatch(/hasn't been tested end to end/);
    expect(t).toMatch(/may not connect/);
    expect(t).toMatch(/even if the connection fails/);
  });
  it("does not name the model vendor in public body copy", () => {
    expect(`${LIVE_AVAILABILITY.title} ${LIVE_AVAILABILITY.body}`).not.toMatch(/Decart|Lucy|fal\.ai/i);
  });
});
