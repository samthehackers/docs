import { and, eq, inArray, sql } from "drizzle-orm";
import { creditLedger, users } from "@/db/schema";
import type { DB, Tx } from "@/lib/db";
import { allocateDebit } from "@/lib/credits-math";

type Runner = DB | Tx;
export type Bucket = "monthly" | "purchased";

export interface Ref { type?: string; id?: string }

/** Authoritative balance: SUM over the append-only ledger. */
export async function ledgerBalance(r: Runner, userId: string) {
  const rows = await r
    .select({ bucket: creditLedger.bucket, total: sql<number>`coalesce(sum(${creditLedger.delta}),0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .groupBy(creditLedger.bucket);
  const monthly = rows.find((x) => x.bucket === "monthly")?.total ?? 0;
  const purchased = rows.find((x) => x.bucket === "purchased")?.total ?? 0;
  return { monthly, purchased, total: monthly + purchased };
}

async function bump(r: Runner, userId: string, bucket: Bucket, delta: number) {
  const col = bucket === "monthly" ? users.creditsMonthly : users.creditsPurchased;
  await r.update(users).set({ [bucket === "monthly" ? "creditsMonthly" : "creditsPurchased"]: sql`${col} + ${delta}` }).where(eq(users.id, userId));
}

/** Append a positive grant row and update the cached balance in the caller's transaction. */
export async function grantCredits(r: Runner, userId: string, amount: number, bucket: Bucket, reason: string, ref: Ref = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("grant must be a positive integer");
  await r.insert(creditLedger).values({ userId, delta: amount, bucket, reason, refType: ref.type, refId: ref.id });
  await bump(r, userId, bucket, amount);
}

/** Debit up to `amount`, monthly bucket first. Locks the user row. Returns credits actually debited. */
export async function debitCredits(tx: Tx, userId: string, amount: number, reason: string, ref: Ref = {}) {
  if (amount <= 0) return { debited: 0, monthly: 0, purchased: 0 };
  await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
  const bal = await ledgerBalance(tx, userId);
  const a = allocateDebit(bal, amount);
  if (a.fromMonthly > 0) {
    await tx.insert(creditLedger).values({ userId, delta: -a.fromMonthly, bucket: "monthly", reason, refType: ref.type, refId: ref.id });
    await bump(tx, userId, "monthly", -a.fromMonthly);
  }
  if (a.fromPurchased > 0) {
    await tx.insert(creditLedger).values({ userId, delta: -a.fromPurchased, bucket: "purchased", reason, refType: ref.type, refId: ref.id });
    await bump(tx, userId, "purchased", -a.fromPurchased);
  }
  return { debited: a.fromMonthly + a.fromPurchased, monthly: a.fromMonthly, purchased: a.fromPurchased };
}

/**
 * Give back what one studio session was charged, to the bucket(s) it was actually taken from, in the caller's
 * transaction (which must hold the session's row lock). The amount is read from the ledger itself (the session's
 * `session` debits minus any `session_refund` already made for it), so a refund can never exceed the charge, and the
 * unique index ledger_session_refund_uq makes a second refund row for the same session and bucket impossible.
 */
export async function refundSessionDebits(tx: Tx, userId: string, sessionId: string) {
  await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
  const rows = await tx.select({ bucket: creditLedger.bucket, reason: creditLedger.reason, total: sql<number>`coalesce(sum(${creditLedger.delta}),0)::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.refType, "session"), eq(creditLedger.refId, sessionId), inArray(creditLedger.reason, ["session", "session_refund"])))
    .groupBy(creditLedger.bucket, creditLedger.reason);
  const owed = (b: Bucket) => Math.max(0, -rows.filter((r) => r.bucket === b).reduce((n, r) => n + r.total, 0));
  const out = { monthly: owed("monthly"), purchased: owed("purchased") };
  for (const bucket of ["monthly", "purchased"] as const) {
    if (out[bucket] <= 0) continue;
    await tx.insert(creditLedger).values({ userId, delta: out[bucket], bucket, reason: "session_refund", refType: "session", refId: sessionId });
    await bump(tx, userId, bucket, out[bucket]);
  }
  return { ...out, total: out.monthly + out.purchased };
}

/** Monthly refill: expire unused monthly credits, then grant the new allowance. Purchased credits are untouched. */
export async function resetMonthly(tx: Tx, userId: string, allowance: number, period: string) {
  await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for update`);
  const bal = await ledgerBalance(tx, userId);
  if (bal.monthly > 0) {
    await tx.insert(creditLedger).values({ userId, delta: -bal.monthly, bucket: "monthly", reason: "monthly_expiry", refType: "refill", refId: period });
    await bump(tx, userId, "monthly", -bal.monthly);
  }
  // An admin may configure a plan with a 0 allowance: expire what is left, grant nothing (and never throw).
  if (allowance > 0) await grantCredits(tx, userId, allowance, "monthly", "monthly_refill", { type: "refill", id: period });
}

/** True if this refill period was already applied (idempotent cron). */
export async function refillApplied(r: Runner, userId: string, period: string) {
  const [row] = await r
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), eq(creditLedger.reason, "monthly_refill"), eq(creditLedger.refId, period)))
    .limit(1);
  return !!row;
}
