import { CAPTURE_SIZE, type Plan, type PlanConfig } from "@/lib/plans";
import { fmtSessionLimit } from "@/lib/account-summary";
import { fmtNum } from "@/lib/utils";

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** What a plan includes, as shown on the pricing cards. Every line is a configured limit, not a quality promise. */
export function planFeatures(p: PlanConfig): string[] {
  const { width, height } = CAPTURE_SIZE[p.maxResolution];
  return [
    `${fmtNum(p.monthlyCredits)} credits every month`,
    `Sessions up to ${fmtSessionLimit(p.maxSessionSeconds)}`,
    `Camera feed requested at ${width}×${height}`,
    `${p.presets} saved presets`,
    p.historyDays ? `${p.historyDays}-day history` : "No history expiry",
    p.clipRecording ? "Snapshots and clip recording" : "Snapshots (no clip recording)",
  ];
}

/** Which plans include clip recording right now (the admin can change this), so public copy never hard-codes "Pro". */
export function clipPlanLabels(plans: Record<Plan, PlanConfig>): string[] {
  return (Object.keys(plans) as Plan[]).filter((k) => plans[k].clipRecording).map((k) => plans[k].label);
}

/** The sentence about saving things: snapshots on every plan, clips only where the plan has them. */
export function savingSentence(plans: Record<Plan, PlanConfig>): string {
  const clip = clipPlanLabels(plans);
  return clip.length
    ? `Save snapshots to your History on every plan. Recording a clip to download is included in ${joinList(clip)}.`
    : "Save snapshots to your History on every plan. Clip recording isn't included in any plan right now.";
}

export interface BillingDetail { term: string; text: string; links?: { label: string; href: string }[] }

/**
 * The "Billing details" list on /pricing: renewal, cancellation, currency, which payment method covers what, what top-ups do,
 * and the refund position. The facts mirror what checkout, the webhooks and the Terms actually do; change them together.
 * `yearlyPrice` is the label for Pro yearly ("TBA" when no price is configured).
 */
export const PAYMENT_METHODS_TEXT =
  "Pro subscriptions are paid through Paystack; which payment methods it offers is up to Paystack and depends on your country. " +
  "Lifetime and top-ups can be paid through Paystack or with cryptocurrency through NOWPayments.";

export function billingDetails({ currency, yearlyPrice, pricesApproved }: { currency: string; yearlyPrice: string; pricesApproved: boolean }): BillingDetail[] {
  const yearly = yearlyPrice !== "TBA"
    ? ` Pro is also available as a yearly subscription for ${yearlyPrice}; choose it on the Billing page once you have an account.`
    : "";
  return [
    { term: "Renewal", text: `Pro renews automatically each period until you cancel.${yearly}` },
    { term: "Cancelling", text: "A Pro subscription can be cancelled from the Billing page (if no Cancel button shows, contact us). It stays active until the end of the period you already paid for; you are not charged again. Lifetime and top-ups are one-time purchases with nothing to cancel." },
    {
      term: "Currency",
      text: `Card prices are shown and charged in ${currency}. Crypto amounts are quoted at checkout and network fees are extra. ${pricesApproved ? "" : "These amounts are not final yet. "}Your bank may add its own conversion fees.`,
    },
    { term: "Payment methods", text: PAYMENT_METHODS_TEXT },
    { term: "Top-ups", text: "Top-up credits never expire. Your monthly credits are used first, then top-up credits." },
    { term: "Lifetime", text: "A one-time payment with no renewal. The Terms do not yet say how long \"lifetime\" lasts." },
    {
      term: "Refunds",
      text: "Payments are non-refundable except where the law requires otherwise. Refunds are not automatic: if something went wrong with a payment, contact us and it is reviewed by hand. The Terms page is still template text. See:",
      links: [{ label: "Terms", href: "/terms" }, { label: "Contact us", href: "/contact" }],
    },
  ];
}
