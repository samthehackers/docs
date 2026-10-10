/** Pure credit/metering math — no I/O, fully unit-tested. */
import type { Plan } from "@/lib/plans";

const DAY_MS = 86_400_000;

/** `d` plus `n` calendar months in UTC, clamped to the end of a shorter month (Jan 31 + 1 month = Feb 28/29), like PostgreSQL. */
export function addMonthsUTC(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

export interface RefillState {
  plan: Plan;
  planRenewsAt: Date | null;
  /** When the monthly bucket was last filled (a monthly_refill or signup_grant ledger row). */
  lastRefillAt: Date | null;
  /** The latest refill made by a PAYMENT (ref id "pay:<reference>"): the start of the paid cycle. */
  anchor: { at: Date; ref: string } | null;
}

/**
 * Does the refill job owe this user a monthly refill now, and under which ledger ref id (idempotency key)?
 *
 * - Free, and paid plans that no payment started (set by an admin): calendar months, as before: once per UTC month ("YYYY-MM").
 * - Paid plans started by a payment refill on that payment's monthly anniversaries ("cycle:<pay ref>:<k>"), so a buyer gets one
 *   allowance per month and never two (the old calendar refill on top of the purchase could hand out a second allowance within
 *   days). The payment itself grants month 0, and every Pro renewal is a new payment that starts a new cycle.
 * - Pro is only refilled for a month that is paid for: the paid period must reach the end of the month being started (3 days'
 *   slack for 31-day periods against shorter months). So Pro monthly is refilled by its renewals, never by this job; Pro yearly
 *   gets months 1-11 here; a lapsed or failed renewal gets nothing until it is paid.
 * - Lifetime never lapses.
 */
export function refillDue(s: RefillState, now: Date): { refId: string } | null {
  if (s.plan === "FREE" || !s.anchor) {
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    if (s.lastRefillAt && s.lastRefillAt.getTime() >= monthStart.getTime()) return null;
    return { refId: now.toISOString().slice(0, 7) };
  }
  let k = 0;
  while (addMonthsUTC(s.anchor.at, k + 1).getTime() <= now.getTime()) k++;
  if (k < 1) return null;
  const cycleStart = addMonthsUTC(s.anchor.at, k);
  if (s.lastRefillAt && s.lastRefillAt.getTime() >= cycleStart.getTime()) return null;
  if (s.plan === "PRO" && !(s.planRenewsAt && s.planRenewsAt.getTime() >= addMonthsUTC(s.anchor.at, k + 1).getTime() - 3 * DAY_MS)) return null;
  return { refId: `cycle:${s.anchor.ref}:${k}` };
}
export interface Balances { monthly: number; purchased: number }

/** Debit monthly credits first, then purchased. Returns what to take from each bucket and any unmet shortfall. */
export function allocateDebit(b: Balances, amount: number) {
  if (amount < 0) throw new Error("amount must be >= 0");
  const fromMonthly = Math.min(Math.max(b.monthly, 0), amount);
  const fromPurchased = Math.min(Math.max(b.purchased, 0), amount - fromMonthly);
  return { fromMonthly, fromPurchased, shortfall: amount - fromMonthly - fromPurchased };
}

export interface MeterInput {
  startedAt: Date;
  now: Date;
  secondsBilled: number;
  maxSeconds: number;
  balance: number; // total spendable credits before this tick
}
export interface MeterResult {
  debit: number;
  secondsBilled: number;
  remaining: number; // credits left after debit
  secondsLeftInSession: number;
  continue: boolean;
  reason?: "credits" | "session_limit";
}

/** Server-clock metering: bill whole elapsed seconds since start, capped by plan limit and available credits. */
export function computeMeter(i: MeterInput): MeterResult {
  const elapsed = Math.max(0, Math.floor((i.now.getTime() - i.startedAt.getTime()) / 1000));
  const cappedElapsed = Math.min(elapsed, i.maxSeconds);
  const owed = Math.max(0, cappedElapsed - i.secondsBilled);
  const debit = Math.min(owed, Math.max(i.balance, 0));
  const remaining = i.balance - debit;
  const secondsBilled = i.secondsBilled + debit;
  const secondsLeftInSession = Math.max(0, i.maxSeconds - secondsBilled);
  let cont = true;
  let reason: MeterResult["reason"];
  if (remaining <= 0) { cont = false; reason = "credits"; }
  else if (cappedElapsed >= i.maxSeconds) { cont = false; reason = "session_limit"; }
  return { debit, secondsBilled, remaining, secondsLeftInSession, continue: cont, reason };
}
