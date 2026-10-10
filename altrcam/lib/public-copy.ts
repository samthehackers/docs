import { CAPTURE_SIZE, LIFETIME_TOPUP_DISCOUNT, type Plan, type PlanConfig } from "@/lib/plans";
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
 * `yearlyPrice` is the price label for Pro yearly, or null when Pro yearly is not on sale.
 */
export const PAYMENT_METHODS_TEXT =
  "Pro subscriptions are paid through Paystack; which payment methods it offers is up to Paystack and depends on your country. " +
  "Lifetime and top-ups can be paid through Paystack or with cryptocurrency through NOWPayments.";

/**
 * What Lifetime is, exactly as the code implements it: one payment (lib/payments/fulfil.ts sets the plan with no renewal date and
 * the daily downgrade never touches it), the plan's own limits, its monthly allowance refilled on the purchase's monthly
 * anniversary (lib/credits-math.ts refillDue), the top-up discount (lib/plans.ts), and a Pro subscription cancelled at Paystack.
 */
export function lifetimeDetail(monthlyCredits: number): string {
  const credits = monthlyCredits > 0
    ? `${fmtNum(monthlyCredits)} credits every month, refilled once a month counted from the day you paid (unused monthly credits don't roll over)`
    : "no monthly credits at the moment";
  return `A one-time payment with no renewal. It gives you the Lifetime plan's limits, ${credits}, and ${Math.round(LIFETIME_TOPUP_DISCOUNT * 100)}% off top-ups. ` +
    "If you have a Pro subscription when you buy it, we cancel that subscription at Paystack for you; if that fails we tell you, so you can cancel it from Paystack's email. " +
    "The Terms do not yet say how long \"lifetime\" lasts.";
}

export function billingDetails({ yearlyPrice, pricesApproved, lifetimeCredits }: { yearlyPrice: string | null; pricesApproved: boolean; lifetimeCredits: number }): BillingDetail[] {
  const yearly = yearlyPrice
    ? ` Pro is also available as a yearly subscription for ${yearlyPrice}.`
    : "";
  return [
    { term: "Renewal", text: `Pro renews automatically each period until you cancel.${yearly}` },
    { term: "Cancelling", text: "A Pro subscription can be cancelled from the Billing page (if no Cancel button shows, contact us). It stays active until the end of the period you already paid for; you are not charged again. Lifetime and top-ups are one-time purchases with nothing to cancel." },
    {
      term: "Currency",
      text: `Card payments through Paystack are charged in Nigerian naira (NGN). Crypto payments through NOWPayments are priced in US dollars (USD); the amount of cryptocurrency is quoted at checkout and network fees are extra. ${pricesApproved ? "" : "These amounts are not final yet. "}Your bank may add its own conversion fees.`,
    },
    { term: "Payment methods", text: PAYMENT_METHODS_TEXT },
    { term: "Top-ups", text: "Top-up credits never expire. Your monthly credits are used first, then top-up credits." },
    { term: "Lifetime", text: lifetimeDetail(lifetimeCredits) },
    {
      term: "Refunds",
      text: "Payments are non-refundable except where the law requires otherwise. Refunds are not automatic: if something went wrong with a payment, contact us and it is reviewed by hand. The Terms page is still template text. See:",
      links: [{ label: "Terms", href: "/terms" }, { label: "Contact us", href: "/contact" }],
    },
  ];
}

/** The Lifetime top-up discount, worded from the constant checkout applies (lib/plans.ts LIFETIME_TOPUP_DISCOUNT). */
export const LIFETIME_TOPUP_LINE = `Lifetime members pay ${Math.round(LIFETIME_TOPUP_DISCOUNT * 100)}% less for top-ups.`;
export const LIFETIME_TOPUP_APPLIED = `Your Lifetime discount is applied: these prices are ${Math.round(LIFETIME_TOPUP_DISCOUNT * 100)}% below the list price, and that is what you are charged.`;

/** What actually works when a renewal fails: this site can't change a card. */
export const PAST_DUE_HELP = "If Paystack emailed you a link to update your card, use it. Otherwise contact support. This site can't change your card.";

/** Shown where sign-up is not open (no sign-in or no database configured): says so instead of selling it. */
export const SIGNUP_CLOSED = "Sign-up isn't open on this deployment yet.";

/**
 * The free-credits promise on the landing page. null when the Free plan grants nothing (an admin can set 0). "Every month" is only
 * said when the monthly refill job can run (it needs CRON_SECRET); otherwise only the sign-up grant is promised.
 */
export function freeCreditsLine(monthlyCredits: number, refillRuns: boolean): string | null {
  if (!(monthlyCredits > 0)) return null;
  return refillRuns ? `${fmtNum(monthlyCredits)} free credits every month. No card needed.` : `${fmtNum(monthlyCredits)} free credits when you sign up. No card needed.`;
}
