import { NextResponse } from "next/server";
import { eq, isNull, sql } from "drizzle-orm";
import { handle, requireCron } from "@/lib/api";
import { db } from "@/lib/db";
import { creditLedger, users } from "@/db/schema";
import { refillApplied, resetMonthly } from "@/lib/credits";
import { refillDue } from "@/lib/credits-math";
import { getPlans } from "@/lib/plan-config";

export const runtime = "nodejs";
export const maxDuration = 300;

const toDate = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)));

/**
 * Daily: refill monthly credits that are due (lib/credits-math.ts refillDue: Free on the 1st of each UTC month, paid plans on
 * the monthly anniversary of the payment that started them). Unused monthly credits expire; purchased top-ups are untouched.
 * Idempotent: each refill has its own ledger ref id, re-checked under the user's row lock.
 */
export const GET = handle(async (req: Request) => {
  requireCron(req);
  const now = new Date();
  const plans = await getPlans();
  const last = sql<unknown>`(select max(l.created_at) from ${creditLedger} l where l.user_id = "users"."id" and l.reason in ('monthly_refill', 'signup_grant'))`;
  const anchorAt = sql<unknown>`(select l.created_at from ${creditLedger} l where l.user_id = "users"."id" and l.reason = 'monthly_refill' and l.ref_id like 'pay:%' order by l.created_at desc, l.id desc limit 1)`;
  const anchorRef = sql<string | null>`(select l.ref_id from ${creditLedger} l where l.user_id = "users"."id" and l.reason = 'monthly_refill' and l.ref_id like 'pay:%' order by l.created_at desc, l.id desc limit 1)`;
  const all = await db().select({ id: users.id, plan: users.plan, planRenewsAt: users.planRenewsAt, last, anchorAt, anchorRef }).from(users).where(isNull(users.deletedAt));
  let refilled = 0;
  for (const u of all) {
    const at = toDate(u.anchorAt);
    const due = refillDue({ plan: u.plan, planRenewsAt: u.planRenewsAt, lastRefillAt: toDate(u.last), anchor: at && u.anchorRef ? { at, ref: u.anchorRef } : null }, now);
    if (!due) continue;
    const applied = await db().transaction(async (tx) => {
      await tx.execute(sql`select 1 from ${users} where ${users.id} = ${u.id} for update`);
      if (await refillApplied(tx, u.id, due.refId)) return false; // another run (or a retry) got here first
      const [cur] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, u.id));
      if (!cur || cur.plan !== u.plan) return false; // the plan changed since the scan; the next run decides again
      await resetMonthly(tx, u.id, plans[u.plan].monthlyCredits, due.refId);
      return true;
    });
    if (applied) refilled++;
  }
  return NextResponse.json({ period: now.toISOString().slice(0, 7), refilled });
});
