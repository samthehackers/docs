import Link from "next/link";
import { desc, eq, and } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { AvailabilityNotice } from "@/components/availability-notice";
import { PricingNotice } from "@/components/pricing-notice";
import { capabilities } from "@/lib/config";
import { Card } from "@/components/ui/card";
import { PricingCards, TopupList, type Tier, type TopupItem } from "@/components/pricing-cards";
import { CancelButton, CheckoutButton } from "@/components/billing/checkout-button";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { payments, subscriptions } from "@/db/schema";
import { isProductId, PRODUCTS, TOPUP_IDS, type ProductId } from "@/lib/plans";
import { getPlans } from "@/lib/plan-config";
import { discountNote, offerPrice, offersFor, payLabel, purchaseBlock, type Offer } from "@/lib/pricing";
import { LIFETIME_TOPUP_APPLIED, LIFETIME_TOPUP_LINE, PAST_DUE_HELP } from "@/lib/public-copy";
import { fmtDate, paymentStatusView, planStatusView, retryable } from "@/lib/account-summary";
import { money } from "@/lib/utils";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function Billing({ searchParams }: { searchParams?: Promise<{ plan?: string }> }) {
  const user = await requireAppUser();
  const plans = await getPlans();
  const sp = (await searchParams) ?? {};
  const [hist, [sub]] = await Promise.all([
    db().select().from(payments).where(eq(payments.userId, user.id)).orderBy(desc(payments.createdAt), desc(payments.id)).limit(50),
    db().select().from(subscriptions).where(and(eq(subscriptions.userId, user.id), eq(subscriptions.status, "active"))).limit(1),
  ]);
  const caps = capabilities();
  const open = { paystack: caps.paystack, nowpayments: caps.nowpayments };
  const ctx = { plans, buyerPlan: user.plan };
  /** On sale AND allowed for this account (the same rules checkout enforces). */
  const offers = (id: ProductId): Offer[] => (purchaseBlock(id, user, !!sub) ? [] : offersFor(id, ctx, open));
  const options = (os: Offer[], label?: string) => os.map((o) => ({ provider: o.provider, label: label ? `${label} · ${offerPrice(o)}` : payLabel(o) }));
  const status = planStatusView(user, !!sub);
  const pro = offers("PRO_MONTHLY"), yearly = offers("PRO_YEARLY"), lifetime = offers("LIFETIME");
  const proShown = offersFor("PRO_MONTHLY", ctx, open)[0] ?? offersFor("PRO_YEARLY", ctx, open)[0];
  const lifetimeShown = offersFor("LIFETIME", ctx, open)[0];
  const tiers: Tier[] = [
    { key: "FREE", price: "Free", cadence: "no card needed" },
    ...(proShown ? [{ key: "PRO" as const, price: offerPrice(proShown), cadence: proShown.product === "PRO_MONTHLY" ? "per month" : "per year", highlight: true, badge: "Subscription" }] : []),
    ...(lifetimeShown ? [{ key: "LIFETIME" as const, price: offerPrice(lifetimeShown), cadence: "one time", note: LIFETIME_TOPUP_LINE }] : []),
  ];
  // Lifetime members are quoted (and charged) the discounted price; the note says so and shows the list price.
  const topups: TopupItem[] = TOPUP_IDS.flatMap((id) => { const o = offers(id); return o.length ? [{ id, price: offerPrice(o[0]), note: discountNote(o[0]) }] : []; });

  // ?plan=<product> comes from the pricing page through sign-up. Validated against the product list; it only pre-selects.
  const picked = sp.plan && isProductId(sp.plan) ? sp.plan : null;
  const pickedBlock = picked ? purchaseBlock(picked, user, !!sub) : null;
  const pickedOffers = picked ? offers(picked) : [];

  return (
    <div className="space-y-10">
      <h1 className="text-3xl font-bold">Billing</h1>
      <PricingNotice />
      <AvailabilityNotice />
      {!caps.paystack && !caps.nowpayments && <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">Payments aren't available on this deployment yet, so checkout is disabled.</p>}
      {status.alert && (
        <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <p>{status.alert}</p>
          <p className="mt-2">{PAST_DUE_HELP} <Link href="/support" className="font-medium underline">Contact support</Link></p>
        </div>
      )}

      {picked && (
        <Card id="checkout" className="border-primary">
          <h2 className="text-lg font-semibold">Continue: {PRODUCTS[picked].label}</h2>
          {pickedBlock ? <p className="mt-2 text-sm text-muted-foreground">{pickedBlock.message.replace(" Nothing was charged.", "")}</p>
            : pickedOffers.length ? <><p className="mt-2 text-sm text-muted-foreground">Choose how to pay. You'll be taken to the payment provider; nothing is charged until you confirm there.</p><CheckoutButton className="mt-4" product={picked} options={options(pickedOffers)} /></>
            : <p className="mt-2 text-sm text-muted-foreground">This isn't on sale right now.</p>}
        </Card>
      )}

      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Current plan</p>
          <p className="text-2xl font-bold">{plans[user.plan].label} <Badge className={`ml-2 align-middle ${status.tone === "warn" ? "border-destructive/60 bg-destructive/10 text-destructive" : ""}`}>{status.label}</Badge></p>
          {status.detail && <p className="text-sm text-muted-foreground">{status.detail}</p>}
        </div>
        {sub && user.planStatus !== "cancelling" && <CancelButton endsLabel={user.planRenewsAt ? fmtDate(user.planRenewsAt) : null} />}
      </Card>

      {user.plan !== "LIFETIME" && tiers.length > 1 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Plans</h2>
          <PricingCards plans={plans} tiers={tiers} current={user.plan} renderCta={(t) => {
            if (t.key === "FREE") return <p className="text-sm text-muted-foreground">{user.plan === "FREE" ? "Your current plan" : "Downgrade by cancelling above"}</p>;
            if (t.key === "PRO") {
              const block = purchaseBlock("PRO_MONTHLY", user, !!sub);
              if (block) return <p className="text-sm text-muted-foreground">{user.plan === "PRO" ? "Your current plan" : block.message.replace(" Nothing was charged.", "")}</p>;
              return (
                <div className="space-y-2">
                  <CheckoutButton product="PRO_MONTHLY" options={options(pro, "Pro monthly")} />
                  <CheckoutButton product="PRO_YEARLY" variant="outline" options={options(yearly, "Pro yearly")} />
                </div>
              );
            }
            return <CheckoutButton product="LIFETIME" variant="outline" options={options(lifetime)} />;
          }} />
        </section>
      )}

      {topups.length > 0 && (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Top up credits</h2>
          {(user.plan === "LIFETIME" || lifetimeShown) && <p className="mb-4 text-sm text-muted-foreground">{user.plan === "LIFETIME" ? LIFETIME_TOPUP_APPLIED : LIFETIME_TOPUP_LINE}</p>}
          <TopupList items={topups} renderCta={(id: ProductId) => <CheckoutButton product={id} variant="outline" options={options(offers(id))} />} />
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-semibold">Payment history</h2>
        {hist.length === 0 ? <Card className="text-center text-sm text-muted-foreground">No payments yet.</Card> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="p-3">Date</th><th className="p-3">Item</th><th className="p-3">Amount</th><th className="p-3">Status</th><th className="p-3">Receipt</th></tr></thead>
              <tbody className="divide-y">
                {hist.map((p) => {
                  const v = paymentStatusView(p.status);
                  const again = retryable(p.status) && isProductId(p.product) ? offers(p.product).filter((o) => o.provider === p.provider) : [];
                  return (
                    <tr key={p.id}>
                      <td className="p-3 whitespace-nowrap">{fmtDate(p.createdAt)}</td>
                      <td className="p-3">{PRODUCTS[p.product as ProductId]?.label ?? p.product}</td>
                      <td className="p-3 whitespace-nowrap">{money(p.amountMinor, p.currency)}</td>
                      <td className="p-3">
                        <Badge className={p.status === "success" ? "" : "border-muted-foreground/40 bg-transparent text-muted-foreground"}>{v.label}</Badge>
                        {v.detail && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{v.detail}</p>}
                      </td>
                      <td className="p-3">
                        {p.status === "success" ? <Link href={`/billing/receipt/${encodeURIComponent(p.reference)}`} className="text-primary underline">Receipt</Link>
                          : again.length ? <CheckoutButton product={p.product as ProductId} variant="outline" options={again.map((o) => ({ provider: o.provider, label: "Try again" }))} />
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
