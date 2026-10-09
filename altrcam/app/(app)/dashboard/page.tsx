import Link from "next/link";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { PlanCard, PresetsCard, ProfileBlock, UpgradeCard, UsageCard, UsageHistory } from "@/components/dashboard-cards";
import { requireAppUser } from "@/lib/session-user";
import { dashboardData, usageHistory } from "@/lib/queries";
import { getPlans } from "@/lib/plan-config";
import { planComparison, planStatusView, fmtDuration } from "@/lib/account-summary";
import { capabilities } from "@/lib/config";
import { fmtNum, relativeTime } from "@/lib/utils";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requireAppUser();
  const [d, usage, plans] = await Promise.all([dashboardData(user.id, user.plan), usageHistory(user.id), getPlans()]);
  const first = user.name.split(" ")[0] || "there";
  const status = planStatusView(user, d.hasActiveSubscription);
  const free = user.plan === "FREE";
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Welcome back, {first}</h1>

      <Card className="flex flex-wrap items-center justify-between gap-4">
        <ProfileBlock name={user.name} email={user.email} avatarUrl={user.avatarUrl} createdAt={user.createdAt} planLabel={plans[user.plan].label} />
        <Link href="/studio" className={buttonClass({ variant: "gradient", size: "lg", className: "w-full sm:w-auto" })}>
          <Clapperboard className="h-5 w-5" aria-hidden /> Open Studio
        </Link>
      </Card>

      {status.alert && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 flex-1">{status.alert}</span>
          <Link href="/billing" className="font-medium underline">Go to Billing</Link>
        </div>
      )}
      {d.lowCredits && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-accent" aria-hidden />
          <span>{d.balance.total <= 0 ? "You're out of credits." : "You're running low on credits."}</span>
          <span className="ml-auto flex gap-4">
            {free && <Link href="/billing" className="font-medium underline">Upgrade to Pro</Link>}
            <Link href="/billing" className="font-medium underline">Top up</Link>
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardTitle>AI Credits remaining</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(d.balance.total)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{fmtNum(d.balance.monthly)} monthly · {fmtNum(d.balance.purchased)} purchased</p></Card>
        <UsageCard allowance={d.allowance} usedMonthly={d.usedMonthly} usedSeconds={d.usedSeconds} usagePct={d.usagePct} />
        <Card><CardTitle>Sessions this month</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(d.sessionsThisMonth)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{fmtDuration(d.usedSeconds)} billed</p></Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <PlanCard planLabel={plans[user.plan].label} view={status} lastPayment={d.lastPayment} />
        <PresetsCard presets={d.presets} count={d.presetCount} cap={plans[user.plan].presets} />
      </div>

      {free && <UpgradeCard rows={planComparison(plans.FREE, plans.PRO)} checkoutAvailable={capabilities().paystack} />}

      <UsageHistory sessions={usage.sessions} credits={usage.credits} />

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">Recent transformations</h2>
          <Link href="/history" className="text-sm font-medium text-primary underline">View history</Link>
        </div>
        {d.recent.length === 0 ? (
          <Card className="text-center text-sm text-muted-foreground">Nothing saved yet. Press Snapshot in the Studio while you&apos;re live to keep a still here.</Card>
        ) : (
          <ul className="divide-y rounded-lg border bg-card">
            {d.recent.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0"><p className="truncate font-medium">{t.title}</p><p className="truncate text-xs text-muted-foreground">{t.type} · {t.prompt}</p></div>
                <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(t.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
