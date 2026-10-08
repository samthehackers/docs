import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { handle, HttpError, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { subscriptions, users } from "@/db/schema";
import { getProvider } from "@/lib/payments";
import { notify } from "@/lib/notifications";

export const POST = handle(async () => {
  const userId = await requireUserId();
  const [s] = await db().select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));
  if (!s) throw new HttpError(404, "No active subscription");
  await getProvider(s.provider as "paystack" | "nowpayments").cancelSubscription?.(s.providerSubId, s.emailToken ?? undefined);
  await db().update(subscriptions).set({ status: "cancelled", cancelAt: s.currentPeriodEnd }).where(eq(subscriptions.id, s.id));
  await db().update(users).set({ planStatus: "cancelling" }).where(eq(users.id, userId));
  await notify(db(), userId, "plan_change", "Subscription cancelled", "Pro stays active until the end of your paid period.");
  return NextResponse.json({ ok: true });
});
