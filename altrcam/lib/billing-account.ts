import { and, eq } from "drizzle-orm";
import { subscriptions } from "@/db/schema";
import { db } from "@/lib/db";
import { getUserRow } from "@/lib/users";
import type { Plan } from "@/lib/plans";

export interface BillingAccount { plan: Plan; planRenewsAt: Date | null; hasActiveSubscription: boolean }

/**
 * What the public pricing page needs to know about a signed-in visitor to pick the right buttons (current plan, can they buy).
 * Never throws: if the account can't be read the page falls back to buttons that go to Billing, where checkout decides.
 */
export async function billingAccount(userId: string): Promise<BillingAccount | null> {
  try {
    const u = await getUserRow(userId);
    if (!u) return null;
    const [s] = await db().select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active"))).limit(1);
    return { plan: u.plan, planRenewsAt: u.planRenewsAt, hasActiveSubscription: !!s };
  } catch (e) {
    console.error("[pricing] could not read the account:", e instanceof Error ? e.message : e);
    return null;
  }
}
