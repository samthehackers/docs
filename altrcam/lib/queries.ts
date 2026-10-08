import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { creditLedger, studioSessions, transformations, users } from "@/db/schema";
import { db } from "@/lib/db";
import { ledgerBalance } from "@/lib/credits";
import { getPlan } from "@/lib/plan-config";
import type { Plan } from "@/lib/plans";

export const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export async function dashboardData(userId: string, plan: Plan) {
  const d = db();
  const since = monthStart();
  const [bal, sessions, used, recent] = await Promise.all([
    ledgerBalance(d, userId),
    d.select({ n: count() }).from(studioSessions).where(and(eq(studioSessions.userId, userId), gte(studioSessions.startedAt, since))),
    d.select({ s: sql<number>`coalesce(-sum(${creditLedger.delta}),0)::int` }).from(creditLedger)
      .where(and(eq(creditLedger.userId, userId), eq(creditLedger.reason, "session"), gte(creditLedger.createdAt, since))),
    d.select().from(transformations).where(eq(transformations.userId, userId)).orderBy(desc(transformations.createdAt)).limit(6),
  ]);
  const allowance = (await getPlan(plan)).monthlyCredits;
  const usedSeconds = used[0]?.s ?? 0;
  return {
    balance: bal,
    sessionsThisMonth: sessions[0]?.n ?? 0,
    usedSeconds,
    allowance,
    usagePct: Math.min(100, Math.round((usedSeconds / allowance) * 100)),
    lowCredits: bal.total < allowance * 0.1,
    recent,
  };
}

export async function activeUserCount() {
  const [r] = await db().select({ n: count() }).from(users);
  return r?.n ?? 0;
}
