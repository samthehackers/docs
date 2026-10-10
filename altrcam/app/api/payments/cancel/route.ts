import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { handle, HttpError, requireUserId } from "@/lib/api";
import { db } from "@/lib/db";
import { subscriptions, users } from "@/db/schema";
import { getProvider } from "@/lib/payments";
import { notify } from "@/lib/notifications";
import { fmtDate } from "@/lib/account-summary";

/** Cancel at period end: stops renewal at the provider first, then records it. Answers with the date Pro ends. */
export const POST = handle(async () => {
  const userId = await requireUserId();
  const [s] = await db().select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, "active")));
  if (!s) throw new HttpError(404, "No active subscription. It may already be cancelled.", { code: "not_active" });
  try {
    await getProvider(s.provider as "paystack" | "nowpayments").cancelSubscription?.(s.providerSubId, s.emailToken ?? undefined);
  } catch (e) {
    console.error("[cancel] provider refused:", s.provider, s.providerSubId, e instanceof Error ? e.message : e);
    throw new HttpError(502, "We couldn't reach the payment provider to cancel, so nothing changed and it will still renew. Try again in a few minutes, use the cancel link in Paystack's email, or contact support.", { code: "provider_unreachable" });
  }
  const [u] = await db().select({ planRenewsAt: users.planRenewsAt }).from(users).where(eq(users.id, userId));
  const endsAt = s.currentPeriodEnd ?? u?.planRenewsAt ?? null;
  await db().update(subscriptions).set({ status: "cancelled", cancelAt: endsAt }).where(eq(subscriptions.id, s.id));
  await db().update(users).set({ planStatus: "cancelling" }).where(eq(users.id, userId));
  const until = endsAt ? `Pro stays active until ${fmtDate(endsAt)}.` : "Pro stays active until the end of your paid period.";
  await notify(db(), userId, "plan_change", "Subscription cancelled", `${until} You won't be charged again.`);
  return NextResponse.json({ ok: true, endsAt: endsAt?.toISOString() ?? null, message: `Cancelled. ${until} You won't be charged again.` });
});
