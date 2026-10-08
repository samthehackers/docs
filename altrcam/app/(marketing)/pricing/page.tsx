import Link from "next/link";
import { PricingCards, TopupList } from "@/components/pricing-cards";
import { buttonClass } from "@/components/ui/button";
import { PricingNotice } from "@/components/pricing-notice";
import { getPlans } from "@/lib/plan-config";

export const metadata = { title: "Pricing" };

export default async function Pricing() {
  const plans = await getPlans();
  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">Simple pricing. <span className="gradient-text">Pay per second.</span></h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">1 credit = 1 second of live AI video. Monthly credits refill; top-ups never expire.</p>
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
    </div>
  );
}
