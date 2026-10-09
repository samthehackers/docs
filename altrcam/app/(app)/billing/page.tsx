import { desc, eq, and } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { PricingNotice } from "@/components/pricing-notice";
import { capabilities } from "@/lib/config";
import { Card } from "@/components/ui/card";
import { PricingCards, TopupList } from "@/components/pricing-cards";
import { CancelButton, CheckoutButton } from "@/components/billing/checkout-button";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { payments, subscriptions } from "@/db/schema";
import { PRODUCTS, type ProductId } from "@/lib/plans";
import { getPlans } from "@/lib/plan-config";
import { priceLabel } from "@/lib/pricing";
import { money } from "@/lib/utils";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function Billing() {
  const user = await requireAppUser();
  const plans = await getPlans();
  const [hist, [sub]] = await Promise.all([
    db().select().from(payments).where(eq(payments.userId, user.id)).orderBy(desc(payments.createdAt)).limit(50),
    db().select().from(subscriptions).where(and(eq(subscriptions.userId, user.id), eq(subscriptions.status, "active"))).limit(1),
  ]);
  return (
    <div className="space-y-10">
      <h1 className="text-3xl font-bold">Billing</h1>
      <PricingNotice />
      {!capabilities().paystack && <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">Payments aren't available on this deployment yet, so checkout is disabled.</p>}

      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Current plan</p>
          <p className="text-2xl font-bold">{plans[user.plan].label} <Badge className="ml-2 align-middle">{user.planStatus}</Badge></p>
          {user.plan === "PRO" && user.planRenewsAt && <p className="text-sm text-muted-foreground">{sub ? "Renews" : "Ends"} {user.planRenewsAt.toLocaleDateString("en", { dateStyle: "medium" })}</p>}
          {user.plan === "LIFETIME" && <p className="text-sm text-muted-foreground">Yours forever.</p>}
        </div>
        {sub && <CancelButton />}
      </Card>

      {user.plan !== "LIFETIME" && (
        <section>
          <h2 className="mb-4 text-xl font-semibold">Plans</h2>
          <PricingCards plans={plans} current={user.plan} renderCta={(t) => {
            if (!t.product) return <p className="text-sm text-muted-foreground">{user.plan === "FREE" ? "Your current plan" : "Downgrade by cancelling above"}</p>;
            if (t.key === "PRO") return (
              <div className="space-y-2">
                <CheckoutButton product="PRO_MONTHLY" label={`Pro monthly · ${priceLabel("PRO_MONTHLY")}`} />
                <CheckoutButton product="PRO_YEARLY" variant="outline" label={`Pro yearly · ${priceLabel("PRO_YEARLY")}`} />
              </div>
            );
            return <CheckoutButton product="LIFETIME" label="Get Lifetime" variant="outline" crypto />;
          }} />
        </section>
      )}

      <section>
        <h2 className="mb-4 text-xl font-semibold">Top up credits</h2>
        <TopupList renderCta={(id: ProductId) => <CheckoutButton product={id} label="Buy" variant="outline" crypto />} />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">Payment history</h2>
        {hist.length === 0 ? <Card className="text-center text-sm text-muted-foreground">No payments yet.</Card> : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="p-3">Date</th><th className="p-3">Item</th><th className="p-3">Amount</th><th className="p-3">Status</th><th className="p-3">Receipt</th></tr></thead>
              <tbody className="divide-y">
                {hist.map((p) => (
                  <tr key={p.id}>
                    <td className="p-3">{p.createdAt.toLocaleDateString("en", { dateStyle: "medium" })}</td>
                    <td className="p-3">{PRODUCTS[p.product as ProductId]?.label ?? p.product}</td>
                    <td className="p-3">{money(p.amountMinor, p.currency)}</td>
                    <td className="p-3"><Badge className={p.status === "success" ? "" : "border-muted-foreground/40 bg-transparent text-muted-foreground"}>{p.status}</Badge></td>
                    <td className="p-3 font-mono text-xs text-muted-foreground">{p.status === "success" ? p.reference : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
