import { CAPTURE_SIZE, type Plan, type PlanConfig } from "@/lib/plans";
import { fmtNum } from "@/lib/utils";

const mins = (s: number) => `${Math.round(s / 60)} min`;

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
    `Sessions up to ${mins(p.maxSessionSeconds)}`,
    `Camera captured at up to ${width}×${height}`,
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
export function billingDetails({ currency, yearlyPrice }: { currency: string; yearlyPrice: string }): BillingDetail[] {
  const yearly = yearlyPrice !== "TBA"
    ? ` Pro is also available as a yearly subscription for ${yearlyPrice}; choose it on the Billing page once you have an account.`
    : "";
  return [
    { term: "Renewal", text: `Pro renews automatically each period until you cancel.${yearly}` },
    { term: "Cancelling", text: "Cancel any time from the Billing page. Pro stays active until the end of the period you already paid for; you are not charged again." },
    { term: "Currency", text: `Prices are shown and charged in ${currency}. Amounts are not final until the pricing notice above is gone, and your bank may add its own conversion fees.` },
    { term: "Payment methods", text: "Pro subscriptions are paid through Paystack, which offers cards and other methods depending on your country. Lifetime and top-ups can be paid through Paystack or with cryptocurrency through NOWPayments." },
    { term: "Top-ups", text: "Top-up credits never expire. Your monthly credits are used first, then top-up credits. A one-time Lifetime purchase does not renew." },
    {
      term: "Refunds",
      text: "Payments are non-refundable except where the law requires otherwise. Refunds are not automatic: if something went wrong with a payment, contact support and it is reviewed by hand. The Terms page is still template text.",
      links: [{ label: "Terms", href: "/terms" }, { label: "Contact us", href: "/contact" }],
    },
  ];
}
