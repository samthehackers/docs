import Link from "next/link";
import { PricingCards, TopupList } from "@/components/pricing-cards";
import { buttonClass } from "@/components/ui/button";
import { PricingNotice } from "@/components/pricing-notice";
import { getPlans } from "@/lib/plan-config";
import { priceCurrency, priceLabel } from "@/lib/pricing";
import { billingDetails } from "@/lib/public-copy";

export const metadata = { title: "Pricing" };

// Shows admin-edited plan limits: re-render at most once a minute instead of freezing the build-time values.
export const revalidate = 60;

export default async function Pricing() {
  const plans = await getPlans();
  const details = billingDetails({ currency: priceCurrency(), yearlyPrice: priceLabel("PRO_YEARLY") });
  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">Simple pricing. <span className="gradient-text">Pay per second.</span></h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">1 credit = 1 second of session time. Monthly credits refill each cycle; top-ups never expire.</p>
      <div className="mt-8"><PricingNotice /></div>
      <div className="mt-4">
        <PricingCards plans={plans} renderCta={(t) => (
          <Link href={t.product ? "/billing" : "/sign-up"} prefetch={t.product ? false : undefined} className={buttonClass({ variant: t.highlight ? "gradient" : "outline", className: "w-full" })}>
            {t.product ? "Choose " + t.key.toLowerCase() : "Start free"}
          </Link>
        )} />
      </div>
      <h2 className="mb-4 mt-16 text-xl font-semibold">Need more? Top up anytime.</h2>
      <TopupList renderCta={() => <Link href="/billing" prefetch={false} className={buttonClass({ variant: "outline", size: "sm" })}>Buy</Link>} />
      <h2 className="mb-4 mt-16 text-xl font-semibold">Billing details</h2>
      <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
        {details.map((d) => (
          <div key={d.term}>
            <dt className="font-medium">{d.term}</dt>
            <dd className="mt-1 text-muted-foreground">
              {d.text}
              {d.links?.map((l) => <span key={l.href}> <Link href={l.href} className="text-primary underline">{l.label}</Link></span>)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
