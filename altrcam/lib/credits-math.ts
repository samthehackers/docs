/** Pure credit/metering math — no I/O, fully unit-tested. */
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
