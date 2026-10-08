import Link from "next/link";
import { AlertTriangle, Clapperboard } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { requireAppUser } from "@/lib/session-user";
import { dashboardData } from "@/lib/queries";
import { PLANS } from "@/lib/plans";
import { fmtNum, relativeTime } from "@/lib/utils";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const user = await requireAppUser();
  const d = await dashboardData(user.id, user.plan);
  const first = user.name.split(" ")[0] || "there";
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">Welcome back, {first}</h1>
        <Badge>{PLANS[user.plan].label}</Badge>
      </div>

      {d.lowCredits && (
        <div role="alert" className="flex items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 p-4 text-sm">
          <AlertTriangle className="h-5 w-5 text-accent" aria-hidden />
          <span>{d.balance.total === 0 ? "You're out of credits." : "You're running low on credits."}</span>
          <Link href="/billing" className="ml-auto font-medium underline">Top up</Link>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardTitle>AI Credits remaining</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(d.balance.total)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{fmtNum(d.balance.monthly)} monthly · {fmtNum(d.balance.purchased)} purchased</p></Card>
        <Card><CardTitle>Sessions this month</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(d.sessionsThisMonth)}</p></Card>
        <Card><CardTitle>Usage of monthly allowance</CardTitle><p className="mt-2 text-4xl font-bold">{d.usagePct}%</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={d.usagePct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly usage">
            <div className="h-full bg-gradient-to-r from-primary to-accent" style={{ width: `${d.usagePct}%` }} /></div></Card>
      </div>

      <Link href="/studio" className={buttonClass({ variant: "gradient", size: "lg", className: "w-full sm:w-auto" })}>
        <Clapperboard className="h-5 w-5" aria-hidden /> Open Studio
      </Link>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent transformations</h2>
        {d.recent.length === 0 ? (
          <Card className="text-center text-sm text-muted-foreground">Nothing yet. Open the studio and become someone.</Card>
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
