import Link from "next/link";
import { PricingCards, TopupList, type Tier, type TopupItem } from "@/components/pricing-cards";
import { buttonClass } from "@/components/ui/button";
import { AvailabilityNotice } from "@/components/availability-notice";
import { PricingNotice } from "@/components/pricing-notice";
import { CheckoutButton } from "@/components/billing/checkout-button";
import { accountsOpen, capabilities, paymentsOpen } from "@/lib/config";
import { getPlans } from "@/lib/plan-config";
import { TOPUP_IDS, type Currency, type ProductId } from "@/lib/plans";
import { discountNote, offer, offerPrice, payLabel, pricesApproved, purchaseBlock, signUpHref, type Offer } from "@/lib/pricing";
import { billingDetails, LIFETIME_TOPUP_LINE, SIGNUP_CLOSED } from "@/lib/public-copy";
import { viewerId } from "@/lib/viewer";
import { billingAccount } from "@/lib/billing-account";

export const metadata = { title: "Pricing" };

// With Clerk configured this page is dynamic (the layout reads the session), so admin-edited plan limits show within the plan-config
// cache time (about 15 s). With no Clerk it is static and revalidates every minute.
export const revalidate = 60;

const CURRENCY_TABS: { c: Currency; label: string; note: string }[] = [
  { c: "NGN", label: "Card · NGN", note: "Card payments through Paystack are charged in naira." },
  { c: "USD", label: "Crypto · USD", note: "Crypto payments through NOWPayments are priced in US dollars. Subscriptions can't be paid with crypto." },
];

export default async function Pricing({ searchParams }: { searchParams?: Promise<{ currency?: string }> }) {
  const plans = await getPlans();
  const sp = (await searchParams) ?? {};
  const view: Currency = sp.currency === "USD" ? "USD" : "NGN"; // NGN by default; anything else is ignored
  const signupOpen = accountsOpen(), checkoutOpen = paymentsOpen();
  const me = await viewerId();
  const account = me ? await billingAccount(me) : null;
  const ctx = { plans, buyerPlan: account?.plan ?? null };
  const caps = capabilities();
  const providerOpen = (o: Offer) => (o.provider === "paystack" ? caps.paystack : caps.nowpayments);
  const other: Currency = view === "NGN" ? "USD" : "NGN";
  /** The offer to show in this view: in the view's currency, else (marked) the other one. Null = not on sale at all: hidden. */
  const shown = (id: ProductId) => {
    const here = offer(id, view, ctx);
    if (here) return { o: here, elsewhere: false };
    const there = offer(id, other, ctx);
    return there ? { o: there, elsewhere: true } : null;
  };
  const elsewhereNote = (o: Offer) => (o.currency === "NGN" ? "Only by card, charged in NGN." : "Only with crypto, priced in USD.");
  const pro = shown("PRO_MONTHLY"), lifetime = shown("LIFETIME"), yearly = offer("PRO_YEARLY", "NGN", ctx);
  const tiers: Tier[] = [
    { key: "FREE", price: "Free", cadence: "no card needed" },
    ...(pro ? [{ key: "PRO" as const, product: "PRO_MONTHLY" as const, price: offerPrice(pro.o), cadence: "per month", highlight: true, badge: "Subscription", note: pro.elsewhere ? "Charged in NGN by card: crypto can't pay for a subscription." : undefined }] : []),
    ...(lifetime ? [{ key: "LIFETIME" as const, product: "LIFETIME" as const, price: offerPrice(lifetime.o), cadence: "one time", note: [lifetime.elsewhere ? elsewhereNote(lifetime.o) : "", LIFETIME_TOPUP_LINE].filter(Boolean).join(" ") }] : []),
  ];
  const topups: TopupItem[] = TOPUP_IDS.flatMap((id) => {
    const s = shown(id);
    return s ? [{ id, price: offerPrice(s.o), note: [discountNote(s.o), s.elsewhere ? elsewhereNote(s.o) : ""].filter(Boolean).join(". ") || undefined }] : [];
  });
  const details = billingDetails({ yearlyPrice: yearly ? offerPrice(yearly) : null, pricesApproved: pricesApproved(), lifetimeCredits: plans.LIFETIME.monthlyCredits });

  /** The button for a paid product: sign-up (resuming to checkout) when signed out, checkout itself when signed in. */
  const buy = (id: ProductId, label: string, variant: "gradient" | "outline", size?: "sm") => {
    if (!checkoutOpen) return <p className="text-center text-sm text-muted-foreground">Not available yet</p>;
    if (!me) {
      if (!signupOpen) return <p className="text-center text-sm text-muted-foreground">Sign-up isn't open yet</p>;
      return <Link href={signUpHref(id)} prefetch={false} className={buttonClass({ variant, size, className: size ? "" : "w-full" })}>{label}</Link>;
    }
    if (account) {
      const block = purchaseBlock(id, account, account.hasActiveSubscription);
      if (block) return <p className="text-center text-sm text-muted-foreground">{block.code === "already_subscribed" && account.plan === "PRO" ? "Current plan" : block.code === "already_lifetime" ? "Included in your Lifetime plan" : block.message.replace(" Nothing was charged.", "")}</p>;
    }
    const s = shown(id);
    const opts = s && providerOpen(s.o) ? [{ provider: s.o.provider, label: id === "PRO_MONTHLY" ? `${label} · ${offerPrice(s.o)}` : payLabel(s.o) }] : [];
    if (!opts.length) return <p className="text-center text-sm text-muted-foreground">Not available yet</p>;
    return <CheckoutButton product={id} variant={variant} options={opts} />;
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">Simple pricing. <span className="gradient-text">Credits by the second.</span></h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">1 credit = 1 second of session time. Monthly credits refill each cycle; top-ups never expire.</p>
      <div className="mt-8"><PricingNotice /></div>
      <AvailabilityNotice className="mb-4" />
      {!checkoutOpen && <p role="status" className="mx-auto mb-4 max-w-xl text-center text-sm text-muted-foreground">{signupOpen ? "Checkout isn't open on this deployment yet." : `${SIGNUP_CLOSED} Checkout isn't open yet either.`}</p>}
      {tiers.length === 1 && <p role="status" className="mx-auto mb-4 max-w-xl text-center text-sm text-muted-foreground">Paid plans aren't on sale yet.</p>}

      {tiers.length > 1 && (
        <nav aria-label="Price currency" className="mx-auto mt-6 flex max-w-md flex-col items-center gap-2">
          <div className="inline-flex rounded-lg border p-1">
            {CURRENCY_TABS.map((t) => (
              <Link key={t.c} href={t.c === "NGN" ? "/pricing" : "/pricing?currency=USD"} scroll={false} aria-current={view === t.c ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${view === t.c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {t.label}
              </Link>
            ))}
          </div>
          <p className="text-center text-xs text-muted-foreground">{CURRENCY_TABS.find((t) => t.c === view)!.note}</p>
        </nav>
      )}

      <h2 className="sr-only">Plans</h2>
      <div className="mt-6">
        <PricingCards plans={plans} tiers={tiers} current={account?.plan} renderCta={(t) => {
          if (!t.product) {
            if (me) return <Link href="/studio" className={buttonClass({ variant: "outline", className: "w-full" })}>Open the studio</Link>;
            if (!signupOpen) return <p className="text-center text-sm text-muted-foreground">Sign-up isn't open yet</p>;
            return <Link href="/sign-up" className={buttonClass({ variant: t.highlight ? "gradient" : "outline", className: "w-full" })}>Start free</Link>;
          }
          return buy(t.product, "Choose " + plans[t.key].label, t.highlight ? "gradient" : "outline");
        }} />
      </div>
      {topups.length > 0 && <>
        <h2 className="mb-4 mt-16 text-xl font-semibold">Need more? Top up anytime.</h2>
        {lifetime && <p className="mb-4 text-sm text-muted-foreground">{LIFETIME_TOPUP_LINE}</p>}
        <TopupList items={topups} renderCta={(id) => buy(id, "Buy", "outline", "sm")} />
      </>}
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
