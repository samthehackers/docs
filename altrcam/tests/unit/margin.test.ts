/**
 * The margin guard (lib/margin.ts) and how it decides what is on sale (lib/pricing.ts quote()). Pure: no database, no network.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { checkMargin, fullUsageCredits, marginInputs, marginTable, minPassingPriceMinor, LIFETIME_MARGIN_MONTHS, type MarginInputs } from "@/lib/margin";
import { quote } from "@/lib/pricing";
import { buyerPrice, DEFAULT_PLANS, LIFETIME_TOPUP_DISCOUNT, PRODUCT_IDS, PRODUCTS, providerSells, type Plan, type PlanConfig } from "@/lib/plans";

const plans = (over: Partial<Record<Plan, Partial<PlanConfig>>> = {}): Record<Plan, PlanConfig> => ({
  FREE: { ...DEFAULT_PLANS.FREE, ...over.FREE }, PRO: { ...DEFAULT_PLANS.PRO, ...over.PRO }, LIFETIME: { ...DEFAULT_PLANS.LIFETIME, ...over.LIFETIME },
});
const inputs = (over: Partial<MarginInputs> = {}): MarginInputs => ({ costPerSecondUsd: 0.01, fxNgnPerUsd: 1000, minMargin: 0.5, ...over });

describe("full usage", () => {
  it("is one month for Pro monthly, twelve for yearly, 36 months of the Lifetime allowance, and a top-up's own credits", () => {
    const p = plans({ PRO: { monthlyCredits: 1000 }, LIFETIME: { monthlyCredits: 200 } });
    expect(fullUsageCredits("PRO_MONTHLY", p)).toBe(1000);
    expect(fullUsageCredits("PRO_YEARLY", p)).toBe(12_000);
    expect(LIFETIME_MARGIN_MONTHS).toBe(36);
    expect(fullUsageCredits("LIFETIME", p)).toBe(36 * 200);
    expect(fullUsageCredits("TOPUP_1K", p)).toBe(1000);
    expect(fullUsageCredits("TOPUP_15K", p)).toBe(15_000);
  });
});

describe("checkMargin (fixtures)", () => {
  // Pro monthly, 1,000 credits at $0.01/s = $10 of model time.
  const p = plans({ PRO: { monthlyCredits: 1000 } });
  it("passes: a $25 (USD) price is a 60% margin", () => {
    const v = checkMargin("PRO_MONTHLY", "USD", 2500, p, inputs());
    expect(v.status).toBe("pass");
    expect(v.costUsd).toBeCloseTo(10);
    expect(v.revenueUsd).toBe(25);
    expect(v.margin).toBeCloseTo(0.6);
  });
  it("fails: a $15 price is a 33% margin, below 50%", () => {
    const v = checkMargin("PRO_MONTHLY", "USD", 1500, p, inputs());
    expect(v.status).toBe("fail");
    expect(v.margin).toBeCloseTo(1 / 3);
    expect(v.detail).toMatch(/below the 50% minimum/);
  });
  it("fails: selling below cost is a negative margin", () => {
    expect(checkMargin("PRO_MONTHLY", "USD", 500, p, inputs()).margin).toBeCloseTo(-1);
  });
  it("converts NGN with FX_NGN_PER_USD: ₦25,000 at 1,000/USD is $25, a pass; at 2,000/USD it is $12.50, a fail", () => {
    expect(checkMargin("PRO_MONTHLY", "NGN", 2_500_000, p, inputs()).status).toBe("pass");
    expect(checkMargin("PRO_MONTHLY", "NGN", 2_500_000, p, inputs({ fxNgnPerUsd: 2000 })).status).toBe("fail");
  });
  it("exactly the minimum passes; one minor unit less fails", () => {
    for (const c of ["NGN", "USD"] as const) {
      const min = minPassingPriceMinor("TOPUP_5K", c, p, inputs())!;
      expect(checkMargin("TOPUP_5K", c, min, p, inputs()).status).toBe("pass");
      expect(checkMargin("TOPUP_5K", c, min - 1, p, inputs()).status).toBe("fail");
    }
    expect(minPassingPriceMinor("TOPUP_5K", "USD", p, inputs())).toBe(10_000); // 5,000 s x $0.01 = $50 cost -> $100 at 50%
  });
  it("cannot be proven without a cost, or (for NGN) without an exchange rate; USD needs no rate", () => {
    expect(checkMargin("PRO_MONTHLY", "USD", 999_999, p, inputs({ costPerSecondUsd: null })).status).toBe("unproven");
    expect(checkMargin("PRO_MONTHLY", "NGN", 999_999_999, p, inputs({ fxNgnPerUsd: null })).status).toBe("unproven");
    expect(checkMargin("PRO_MONTHLY", "USD", 2500, p, inputs({ fxNgnPerUsd: null })).status).toBe("pass");
    expect(checkMargin("PRO_MONTHLY", "USD", 2500, p, inputs({ minMargin: null })).status).toBe("unproven");
  });
  it("follows MIN_MARGIN: a 33% margin passes at 0.3", () => {
    expect(checkMargin("PRO_MONTHLY", "USD", 1500, p, inputs({ minMargin: 0.3 })).status).toBe("pass");
  });
});

describe("reading the inputs from env", () => {
  it("defaults MIN_MARGIN to 0.5 and treats unset or non-positive cost/FX as unknown", () => {
    expect(marginInputs({})).toEqual({ costPerSecondUsd: null, fxNgnPerUsd: null, minMargin: 0.5 });
    expect(marginInputs({ FAL_COST_PER_SECOND_USD: "0.04", FX_NGN_PER_USD: "1500", MIN_MARGIN: "0.6" })).toEqual({ costPerSecondUsd: 0.04, fxNgnPerUsd: 1500, minMargin: 0.6 });
    for (const bad of ["0", "-1", "abc", " "]) expect(marginInputs({ FAL_COST_PER_SECOND_USD: bad }).costPerSecondUsd, bad).toBeNull();
    for (const bad of ["1", "1.5", "-0.1", "half"]) expect(marginInputs({ MIN_MARGIN: bad }).minMargin, bad).toBeNull(); // invalid fails closed
  });
});

describe("what is on sale (quote)", () => {
  const env = { FAL_COST_PER_SECOND_USD: "0.01", FX_NGN_PER_USD: "1000", PRICE_TOPUP_1K_NGN: "3000000", PRICE_TOPUP_1K_USD: "1000" };
  // 1,000 credits x $0.01 = $10. ₦30,000 = $30 (67%): on sale. $10 (0%): not on sale.
  it("offers a product whose margin passes and hides one whose margin fails", () => {
    expect(quote("TOPUP_1K", "NGN", { plans: plans(), env }).ok).toBe(true);
    expect(quote("TOPUP_1K", "USD", { plans: plans(), env })).toMatchObject({ ok: false, reason: "margin_fails" });
  });
  it("hides everything paid while the cost is unknown, and NGN prices while the exchange rate is unknown", () => {
    expect(quote("TOPUP_1K", "NGN", { plans: plans(), env: { ...env, FAL_COST_PER_SECOND_USD: "" } })).toMatchObject({ ok: false, reason: "margin_unproven" });
    expect(quote("TOPUP_1K", "NGN", { plans: plans(), env: { ...env, FX_NGN_PER_USD: undefined } })).toMatchObject({ ok: false, reason: "margin_unproven" });
  });
  it("uses the EFFECTIVE allowance: an admin raising Pro's allowance takes Pro off sale", () => {
    const e = { FAL_COST_PER_SECOND_USD: "0.01", FX_NGN_PER_USD: "1000", PRICE_PRO_MONTHLY_NGN: "3000000" }; // ₦30,000 = $30
    expect(quote("PRO_MONTHLY", "NGN", { plans: plans({ PRO: { monthlyCredits: 1000 } }), env: e }).ok).toBe(true); // $10 cost
    expect(quote("PRO_MONTHLY", "NGN", { plans: plans({ PRO: { monthlyCredits: 2000 } }), env: e })).toMatchObject({ ok: false, reason: "margin_fails" }); // $20 cost, 33%
  });
  it("never tells a buyer why: the message is the same 'not on sale, nothing charged' for every reason", () => {
    const q = quote("TOPUP_1K", "USD", { plans: plans(), env });
    expect(q.ok ? "" : q.message).toBe("This isn't on sale right now. Nothing was charged.");
  });
});

describe("the Lifetime top-up discount", () => {
  it("takes 20% off top-ups for Lifetime members only, rounded to a whole minor unit, and nothing else", () => {
    const env = { PRICE_TOPUP_1K_NGN: "300001", PRICE_LIFETIME_NGN: "9900000", PRICE_PRO_MONTHLY_NGN: "1500000" };
    expect(LIFETIME_TOPUP_DISCOUNT).toBe(0.2);
    expect(buyerPrice("TOPUP_1K", "NGN", "LIFETIME", env)).toBe(240001); // 240000.8 rounds to 240001
    expect(buyerPrice("TOPUP_1K", "NGN", "PRO", env)).toBe(300001);
    expect(buyerPrice("TOPUP_1K", "NGN", "FREE", env)).toBe(300001);
    expect(buyerPrice("TOPUP_1K", "NGN", null, env)).toBe(300001);
    expect(buyerPrice("PRO_MONTHLY", "NGN", "LIFETIME", env)).toBe(1500000);
    expect(buyerPrice("LIFETIME", "NGN", "LIFETIME", env)).toBe(9900000);
  });
  it("is checked by the margin guard at the DISCOUNTED price: a top-up can be on sale to everyone and hidden from members", () => {
    // 1,000 credits x $0.01 = $10. List $25 = 60% (pass). Member price $20 = 50% (pass). List $22 = 54.5% (pass); member $17.60 = 43% (fail).
    const env = (usd: string) => ({ FAL_COST_PER_SECOND_USD: "0.01", PRICE_TOPUP_1K_USD: usd });
    expect(quote("TOPUP_1K", "USD", { plans: plans(), buyerPlan: "LIFETIME", env: env("2500") })).toMatchObject({ ok: true, offer: { amountMinor: 2000, listMinor: 2500 } });
    expect(quote("TOPUP_1K", "USD", { plans: plans(), buyerPlan: "FREE", env: env("2200") }).ok).toBe(true);
    expect(quote("TOPUP_1K", "USD", { plans: plans(), buyerPlan: "LIFETIME", env: env("2200") })).toMatchObject({ ok: false, reason: "margin_fails" });
  });
  it("the margin table has a member row per top-up, and its minimum is the list price whose discounted price passes", () => {
    const rows = marginTable(plans(), { FAL_COST_PER_SECOND_USD: "0.01" }).filter((r) => r.product === "TOPUP_1K" && r.currency === "USD");
    expect(rows.map((r) => r.buyer)).toEqual(["everyone", "lifetime member"]);
    expect(rows[0].minPriceMinor).toBe(2000); // $20 list
    expect(rows[1].minPriceMinor).toBe(2500); // $25 list -> $20 paid
  });
});

/** The env block between the margin-example markers in the setup docs (GO_LIVE.md, or docs/SETUP.md once it moves there). */
function documentedExample(): Record<string, string> {
  const file = ["docs/SETUP.md", "GO_LIVE.md"].find((f) => existsSync(f) && readFileSync(f, "utf8").includes("<!-- margin-example:begin -->"));
  expect(file, "a setup doc carries the margin example").toBeTruthy();
  const text = readFileSync(file!, "utf8");
  const block = text.slice(text.indexOf("<!-- margin-example:begin -->"), text.indexOf("<!-- margin-example:end -->"));
  return Object.fromEntries([...block.matchAll(/^([A-Z0-9_]+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));
}

describe("the documented example plan set", () => {
  const env = documentedExample();
  const examplePlans = () => plans(env.LIFETIME_MONTHLY_CREDITS ? { LIFETIME: { monthlyCredits: Number(env.LIFETIME_MONTHLY_CREDITS) } } : {});
  it("does not lose money: every priced row passes the guard, for every buyer", () => {
    expect(env.FAL_COST_PER_SECOND_USD).toBeTruthy();
    const rows = marginTable(examplePlans(), env).filter((r) => r.priceMinor !== null);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.status, `${r.product} ${r.currency} (${r.buyer}): ${r.verdict?.detail}`).toBe("pass");
  });
  it("puts every product on sale in at least one currency", () => {
    for (const id of PRODUCT_IDS) {
      const sellable = (["NGN", "USD"] as const).filter((c) => providerSells(c === "NGN" ? "paystack" : "nowpayments", id));
      expect(sellable.some((c) => quote(id, c, { plans: examplePlans(), env }).ok), `${PRODUCTS[id].label} is on sale`).toBe(true);
    }
  });
  it("is a real check: the same example at half price fails", () => {
    const half = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k.startsWith("PRICE_") ? String(Math.floor(Number(v) / 2)) : v]));
    const rows = marginTable(examplePlans(), half).filter((r) => r.priceMinor !== null);
    expect(rows.every((r) => r.status === "fail")).toBe(true);
  });
});
