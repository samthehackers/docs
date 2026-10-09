import { and, count, desc, eq, gte, ilike, or, sql } from "drizzle-orm";
import { auditLog, payments, planConfig, studioSessions, subscriptions, supportTickets, users, webhookEvents } from "@/db/schema";
import { db } from "@/lib/db";
import { PRODUCTS, type ProductId } from "@/lib/plans";
import { getPlans } from "@/lib/plan-config";
import { requireAdminPage } from "@/lib/session-user";

/**
 * Every function here reads other people's private data, so each one checks the caller is an admin ITSELF, first.
 * The admin layout redirects non-admins too, but a layout is not a security boundary: Next.js renders a layout and its
 * page in parallel, so a redirect in the layout does not stop the page (or anything it calls) from running.
 */
const gate = () => requireAdminPage();

export async function kpis() {
  await gate();
  const d = db();
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const [secs] = await d.select({ s: sql<number>`coalesce(sum(${studioSessions.secondsBilled}),0)::int` }).from(studioSessions).where(gte(studioSessions.startedAt, today));
  const [active] = await d.select({ n: sql<number>`count(distinct ${studioSessions.userId})::int` }).from(studioSessions).where(gte(studioSessions.startedAt, new Date(Date.now() - 30 * 86_400_000)));
  const [total] = await d.select({ n: count() }).from(users);
  // MRR: latest successful subscription payment per active Pro user, yearly normalised to monthly.
  const pro = await d.select({ id: users.id }).from(users).where(and(eq(users.plan, "PRO"), eq(users.planStatus, "active")));
  const subs = await d.select().from(payments).where(and(eq(payments.kind, "subscription"), eq(payments.status, "success"))).orderBy(desc(payments.createdAt));
  const proIds = new Set(pro.map((u) => u.id));
  const seen = new Set<string>();
  const mrr: Record<string, number> = {};
  for (const p of subs) {
    if (!p.userId || !proIds.has(p.userId) || seen.has(p.userId)) continue;
    seen.add(p.userId);
    mrr[p.currency] = (mrr[p.currency] ?? 0) + Math.round(p.amountMinor / (p.product === "PRO_YEARLY" ? 12 : 1));
  }
  return { realtimeSecondsToday: secs?.s ?? 0, activeUsers30d: active?.n ?? 0, totalUsers: total?.n ?? 0, proUsers: pro.length, mrr };
}

export async function searchUsers(q: string) {
  await gate();
  const term = `%${q.replace(/[%_]/g, "")}%`;
  return db().select().from(users).where(q ? or(ilike(users.email, term), ilike(users.name, term), eq(users.id, q)) : undefined).orderBy(desc(users.createdAt)).limit(50);
}

export async function userDetail(id: string) {
  await gate();
  const d = db();
  const [u] = await d.select().from(users).where(eq(users.id, id));
  if (!u) return null;
  const [sessions, pays, subs] = await Promise.all([
    d.select().from(studioSessions).where(eq(studioSessions.userId, id)).orderBy(desc(studioSessions.startedAt)).limit(20),
    d.select().from(payments).where(eq(payments.userId, id)).orderBy(desc(payments.createdAt)).limit(20),
    d.select().from(subscriptions).where(eq(subscriptions.userId, id)),
  ]);
  return { user: u, sessions, payments: pays, subscriptions: subs };
}

export const productLabel = (p: string) => PRODUCTS[p as ProductId]?.label ?? p;

export async function adminPayments() {
  await gate();
  return db().select().from(payments).orderBy(desc(payments.createdAt)).limit(100);
}
export async function adminSessions() {
  await gate();
  return db().select().from(studioSessions).orderBy(desc(studioSessions.startedAt)).limit(100);
}
export async function adminTickets() {
  await gate();
  return db().select().from(supportTickets).orderBy(desc(supportTickets.createdAt)).limit(50);
}
export async function adminWebhooks() {
  await gate();
  return db().select({ id: webhookEvents.id, provider: webhookEvents.provider, type: webhookEvents.type, at: webhookEvents.processedAt, eventId: webhookEvents.eventId }).from(webhookEvents).orderBy(desc(webhookEvents.processedAt)).limit(100);
}
export async function adminAudit() {
  await gate();
  return db().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100);
}
export async function adminPlans() {
  await gate();
  const [plans, rows] = await Promise.all([getPlans(db()), db().select({ plan: planConfig.plan }).from(planConfig)]);
  return { plans, customised: new Set(rows.map((r) => r.plan)) };
}
