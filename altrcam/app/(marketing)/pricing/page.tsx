import Link from "next/link";
import { PricingCards, TopupList } from "@/components/pricing-cards";
import { buttonClass } from "@/components/ui/button";
import { AvailabilityNotice } from "@/components/availability-notice";
import { PricingNotice } from "@/components/pricing-notice";
import { getPlans } from "@/lib/plan-config";
import { priceCurrency, priceLabel, pricesApproved } from "@/lib/pricing";
import { billingDetails } from "@/lib/public-copy";

export const metadata = { title: "Pricing" };

// With Clerk configured this page is dynamic (the layout reads the session), so admin-edited plan limits show within the plan-config
// cache time (about 15 s). With no Clerk it is static and revalidates every minute.
export const revalidate = 60;

export default async function Pricing() {
  const plans = await getPlans();
  const details = billingDetails({ currency: priceCurrency(), yearlyPrice: priceLabel("PRO_YEARLY"), pricesApproved: pricesApproved() });
  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">Simple pricing. <span className="gradient-text">Credits by the second.</span></h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">1 credit = 1 second of session time. Monthly credits refill each cycle; top-ups never expire.</p>
      <div className="mt-8"><PricingNotice /></div>
      <AvailabilityNotice className="mb-4" />
      <div className="mt-4">
        <PricingCards plans={plans} renderCta={(t) => (
          <Link href={t.product ? "/billing" : "/sign-up"} prefetch={t.product ? false : undefined} className={buttonClass({ variant: t.highlight ? "gradient" : "outline", className: "w-full" })}>
            {t.product ? "Choose " + plans[t.key].label : "Start free"}
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
              {d.links?.map((l, i) => <span key={l.href}>{i > 0 ? " · " : " "}<Link href={l.href} className="text-primary underline">{l.label}</Link></span>)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
