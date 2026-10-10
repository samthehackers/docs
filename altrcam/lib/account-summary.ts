/**
 * Pure helpers for the signed-in account views (dashboard): usage maths, status wording and labels.
 * No I/O, so the wording and the edge cases (a plan with a zero allowance, a failed renewal) are unit-tested.
 */
import { CAPTURE_SIZE, LOW_CREDIT_RATIO, STALE_AFTER_SECONDS, type Plan, type PlanConfig } from "@/lib/plans";
import { fmtNum } from "@/lib/utils";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
/** Calendar dates are shown in UTC so the server's time zone cannot move them to a different day. */
export const fmtDate = (d: Date) => DATE.format(d);

const MONTH_YEAR = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
export const fmtMonthYear = (d: Date) => MONTH_YEAR.format(d);

/** Up to two initials for the avatar fallback: from the name, else the email, else "?". */
export function initials(name: string, email: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0]?.slice(0, 2) ?? email.trim()[0] ?? "";
  return letters ? letters.toUpperCase() : "?";
}

/** Length of a session as written on a card: 45s, 2m 05s, 1h 2m. */
export function fmtDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** A plan's longest session, e.g. "2 min" or "1 min 30 sec". */
export function fmtSessionLimit(seconds: number) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.floor(seconds / 60);
  return seconds % 60 ? `${m} min ${seconds % 60} sec` : `${m} min`;
}

/**
 * Share of the monthly allowance used, 0 to 100. null when the plan has no monthly allowance
 * (an admin can set it to 0): there is nothing to measure against, and 0/0 would print "NaN%".
 */
export function usagePercent(usedFromMonthly: number, allowance: number): number | null {
  if (!(allowance > 0)) return null;
  return Math.min(100, Math.max(0, Math.round((usedFromMonthly / allowance) * 100)));
}

/**
 * Show the low-credit banner: under LOW_CREDIT_RATIO of the allowance, or empty. An empty balance counts even on a
 * plan with no allowance, where the ratio test alone (`total < 0`) could never fire.
 */
export function isLowCredit(total: number, allowance: number) {
  return total <= 0 || total < allowance * LOW_CREDIT_RATIO;
}

/** What the credit ledger's `reason` codes mean to the person reading their own activity. Anything unknown is not echoed. */
const LEDGER_LABELS: Record<string, string> = {
  signup_grant: "Signup credits",
  monthly_refill: "Monthly credits added",
  monthly_expiry: "Unused monthly credits expired",
  topup_purchase: "Top-up purchased",
  referral_reward: "Referral reward",
  admin_grant: "Credits added by AltrCam",
  admin_revoke: "Credits removed by AltrCam",
  session: "Live session",
};
export const ledgerReasonLabel = (reason: string) => LEDGER_LABELS[reason] ?? "Other credit change";

/** How a studio session ended (studio_sessions.end_reason). null means it has not been closed. */
const END_LABELS: Record<string, string> = {
  credits: "Ran out of credits",
  session_limit: "Reached your plan's session limit",
  user: "Ended by you",
  stale: "Stopped checking in (connection lost or tab closed)",
  superseded: "Replaced by a newer session",
  failed_connect: "Never connected (no credits used)",
  connection_failed: "The connection failed",
  camera_lost: "Your camera stopped",
  reconnect: "Replaced when you pressed Reconnect",
};
/**
 * `lastSeen` is the last heartbeat. An unclosed session that has been silent longer than the stale cut-off is not running any more;
 * it is closed (and billed up to that last heartbeat) by the stale sweep or when its owner next goes live.
 */
export function sessionEndLabel(reason: string | null, lastSeen?: Date | null, now = new Date()): string {
  if (reason !== null) return END_LABELS[reason] ?? "Ended";
  if (lastSeen && now.getTime() - lastSeen.getTime() > STALE_AFTER_SECONDS * 1000) return "Stopped checking in; it will be closed automatically";
  return "Still open";
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export interface PlanStatusView {
  label: string;
  detail: string | null;
  tone: "ok" | "warn" | "neutral";
  /** Set when the person needs to act: shown as a banner. */
  alert: string | null;
}

/**
 * Human wording for `users.plan_status` (set by the payment webhooks, the cancel route and the daily downgrade).
 * "Renews" is only said when an active subscription is on record, the same rule the Billing page uses.
 */
export function planStatusView(
  u: { plan: Plan; planStatus: string; planRenewsAt: Date | null },
  hasActiveSubscription: boolean,
  now = new Date(),
): PlanStatusView {
  const end = u.planRenewsAt ? fmtDate(u.planRenewsAt) : null;
  const periodOpen = !!u.planRenewsAt && u.planRenewsAt.getTime() > now.getTime();

  if (u.plan === "LIFETIME") return { label: "Never expires", detail: "No renewal needed.", tone: "ok", alert: null };

  if (u.planStatus === "past_due") {
    return {
      label: "Payment failed",
      detail: end ? `Paid period ${periodOpen ? "ends" : "ended"} ${end}` : null,
      tone: "warn",
      alert: `Your last ${u.plan === "PRO" ? "Pro " : ""}renewal payment failed. If no payment goes through, your plan moves back to Free${periodOpen ? ` after ${end}` : " shortly"}. See Billing for your options.`,
    };
  }
  if (u.planStatus === "cancelling") {
    if (end && !periodOpen) return { label: "Cancelled", detail: `Pro ended ${end}; your plan is switching to Free shortly.`, tone: "neutral", alert: null };
    return { label: "Cancelled", detail: end ? `Pro stays active until ${end}.` : "Pro stays active until the end of your paid period.", tone: "neutral", alert: null };
  }
  if (u.planStatus === "expired") {
    return { label: "Pro ended", detail: "Your Pro plan ended and you are on Free. Purchased credits are kept.", tone: "neutral", alert: null };
  }
  if (u.planStatus === "active") {
    if (u.plan === "FREE") return { label: "No subscription", detail: null, tone: "ok", alert: null };
    // The renewal date has passed but the plan has not been switched yet: say so instead of printing a date in the past as the future.
    if (hasActiveSubscription && end && !periodOpen) return { label: "Active", detail: `Renewal was due ${end}; waiting for the payment to be confirmed.`, tone: "neutral", alert: null };
    if (hasActiveSubscription) return { label: "Active", detail: end ? `Renews ${end}` : null, tone: "ok", alert: null };
    if (end && !periodOpen) return { label: "Not renewing", detail: `Pro ended ${end}; your plan is switching to Free shortly.`, tone: "neutral", alert: null };
    return { label: "Not renewing", detail: end ? `Pro is active until ${end}. No active subscription is on record, so it will not renew.` : "No active subscription is on record, so it will not renew.", tone: "neutral", alert: null };
  }
  return { label: capitalise(u.planStatus), detail: end ? `Until ${end}` : null, tone: "neutral", alert: null };
}

/** The plan setting controls the camera size the Studio asks for, not the quality of what the AI returns. */
const captureLabel = (p: PlanConfig) => `${CAPTURE_SIZE[p.maxResolution].width}×${CAPTURE_SIZE[p.maxResolution].height}`;

export interface ComparisonRow { label: string; free: string; pro: string }

/** Free against Pro, read from the effective plan limits (admin overrides included), for the upgrade card. */
export function planComparison(free: PlanConfig, pro: PlanConfig): ComparisonRow[] {
  const days = (n: number | null) => (n ? `${n} days` : "No expiry");
  return [
    { label: "Credits per month", free: fmtNum(free.monthlyCredits), pro: fmtNum(pro.monthlyCredits) },
    { label: "Longest session", free: fmtSessionLimit(free.maxSessionSeconds), pro: fmtSessionLimit(pro.maxSessionSeconds) },
    { label: "Camera capture", free: captureLabel(free), pro: captureLabel(pro) },
    { label: "Saved presets", free: fmtNum(free.presets), pro: fmtNum(pro.presets) },
    { label: "History kept", free: days(free.historyDays), pro: days(pro.historyDays) },
    { label: "Clip recording", free: free.clipRecording ? "Yes" : "No", pro: pro.clipRecording ? "Yes" : "No" },
  ];
}
