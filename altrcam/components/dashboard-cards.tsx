/**
 * Presentational pieces of /dashboard. Server components that take plain props, so the wording and the
 * edge cases (no monthly allowance, a failed renewal, nothing saved yet) can be rendered in unit tests.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import {
  fmtDate, fmtDuration, fmtMonthYear, initials, ledgerReasonLabel, sessionEndLabel, type ComparisonRow, type PlanStatusView,
} from "@/lib/account-summary";
import { PRODUCTS, type ProductId } from "@/lib/plans";
import { fmtNum, money } from "@/lib/utils";

const warnBadge = "border-destructive/50 bg-destructive/10 text-destructive";

export function ProfileBlock(p: { name: string; email: string; avatarUrl: string | null; createdAt: Date; planLabel: string }) {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <span className="relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/15 text-lg font-semibold text-primary" aria-hidden>
        {initials(p.name, p.email)}
        {/* The initials stay underneath, so a picture that fails to load still leaves something sensible. */}
        {p.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.avatarUrl} alt="" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
        ) : null}
      </span>
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold">{p.name || "Your account"}</p>
        <p className="truncate text-sm text-muted-foreground">{p.email}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Badge>{p.planLabel}</Badge>
          <span>Member since {fmtMonthYear(p.createdAt)}</span>
          <Link href="/settings" className="font-medium text-primary underline">Manage profile</Link>
        </p>
      </div>
    </div>
  );
}

/** Credits used against the monthly allowance. A plan with no allowance gets a sentence instead of a meter (0/0 is NaN). */
export function UsageCard(p: { allowance: number; usedMonthly: number; usedSeconds: number; usagePct: number | null }) {
  if (p.usagePct === null) {
    return (
      <Card>
        <CardTitle>Monthly credits</CardTitle>
        <p className="mt-2 text-sm">Your plan doesn&apos;t include monthly credits, so there is no allowance to measure.</p>
        <p className="mt-1 text-xs text-muted-foreground">{fmtNum(p.usedSeconds)} credits spent on live sessions this month.</p>
      </Card>
    );
  }
  const fromPurchased = p.usedSeconds - p.usedMonthly;
  // The allowance can be smaller than what was spent earlier this month (Pro lapsed, or an admin lowered it).
  const overAllowance = p.usedMonthly > p.allowance;
  return (
    <Card>
      <CardTitle>Usage of monthly allowance</CardTitle>
      <p className="mt-2 text-4xl font-bold">{p.usagePct}%</p>
      <p className="mt-1 text-xs text-muted-foreground">{fmtNum(Math.min(p.usedMonthly, p.allowance))} of {fmtNum(p.allowance)} credits used this month</p>
      {overAllowance && <p className="mt-1 text-xs text-muted-foreground">You spent {fmtNum(p.usedMonthly)} monthly credits this month in total; part of that was under a larger allowance than your plan has now.</p>}
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={p.usagePct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly usage">
        <div className="h-full bg-gradient-to-r from-primary to-accent" style={{ width: `${p.usagePct}%` }} />
      </div>
      {fromPurchased > 0 && <p className="mt-2 text-xs text-muted-foreground">Another {fmtNum(fromPurchased)} came from purchased credits.</p>}
    </Card>
  );
}

export function PlanCard(p: {
  planLabel: string; view: PlanStatusView;
  lastPayment: { product: string; amountMinor: number; currency: string; createdAt: Date } | null;
}) {
  const bought = p.lastPayment ? PRODUCTS[p.lastPayment.product as ProductId]?.label ?? p.lastPayment.product : null;
  return (
    <Card>
      <CardTitle>Plan and payment</CardTitle>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-2xl font-bold">
        {p.planLabel} <Badge className={p.view.tone === "warn" ? warnBadge : undefined}>{p.view.label}</Badge>
      </p>
      {p.view.detail && <p className="mt-1 text-sm text-muted-foreground">{p.view.detail}</p>}
      <p className="mt-3 text-sm">
        {p.lastPayment && bought
          ? <>Last payment: {money(p.lastPayment.amountMinor, p.lastPayment.currency)} for {bought} on {fmtDate(p.lastPayment.createdAt)}.</>
          : "No payments yet."}
      </p>
      <Link href="/billing" className={buttonClass({ variant: "outline", size: "sm", className: "mt-4" })}>Manage billing</Link>
    </Card>
  );
}

/** Free-plan only (the page decides). The figures are the effective plan limits, so admin changes show up here too. */
export function UpgradeCard(p: { rows: ComparisonRow[]; checkoutAvailable: boolean }) {
  return (
    <Card className="border-primary/40">
      <h2 className="text-lg font-semibold">Upgrade to Pro</h2>
      <p className="mt-1 text-sm text-muted-foreground">How Pro differs from your Free plan today.</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Free plan compared with Pro</caption>
          <thead className="text-xs text-muted-foreground">
            <tr><th scope="col" className="py-2 pr-4 font-medium">Limit</th><th scope="col" className="py-2 pr-4 font-medium">Free (yours)</th><th scope="col" className="py-2 font-medium">Pro</th></tr>
          </thead>
          <tbody className="divide-y">
            {p.rows.map((r) => (
              <tr key={r.label}><th scope="row" className="py-2 pr-4 font-normal text-muted-foreground">{r.label}</th><td className="py-2 pr-4">{r.free}</td><td className="py-2 font-medium">{r.pro}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link href="/billing" className={buttonClass({ variant: "gradient", className: "mt-4" })}>See Pro plans</Link>
      {!p.checkoutAvailable && <p role="status" className="mt-3 text-xs text-muted-foreground">Payments aren&apos;t available on this deployment yet, so checkout is disabled.</p>}
    </Card>
  );
}

export function PresetsCard(p: { presets: { id: number; name: string; kind: string }[]; count: number; cap: number }) {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <CardTitle>Saved presets</CardTitle>
        <span className="text-xs text-muted-foreground">{p.count} of {p.cap} used</span>
      </div>
      {p.presets.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No saved presets yet. Save one from the Studio, or create one on the Presets page.</p>
      ) : (
        <ul className="mt-3 divide-y text-sm">
          {p.presets.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-3 py-2">
              <Link href={`/studio?preset=${x.id}`} className="min-w-0 truncate font-medium text-primary underline-offset-2 hover:underline">{x.name}</Link>
              <span className="shrink-0 text-xs text-muted-foreground">{x.kind}</span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/presets" className={buttonClass({ variant: "outline", size: "sm", className: "mt-4" })}>{p.count > p.presets.length ? `All ${p.count} presets` : "Manage presets"}</Link>
    </Card>
  );
}

export interface SessionRow { id: string; startedAt: Date; endReason: string | null; lastHeartbeatAt: Date; secondsBilled: number; refundedCredits?: number; prompt: string | null }
export interface CreditRow { id: number; createdAt: Date; delta: number; bucket: string; reason: string }

export function UsageHistory(p: { sessions: SessionRow[]; credits: CreditRow[] }) {
  return (
    <section aria-labelledby="usage-h" className="space-y-3">
      <h2 id="usage-h" className="text-lg font-semibold">Usage history</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>Recent live sessions</CardTitle>
          {p.sessions.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No live sessions yet. Each session you run in the Studio is listed here with its length and the credits it used.</p>
          ) : (
            <ul className="mt-3 divide-y text-sm">
              {p.sessions.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">{fmtDate(s.startedAt)} · {fmtDuration(s.secondsBilled)}</p>
                    {s.prompt && <p className="truncate text-xs text-muted-foreground">{s.prompt}</p>}
                    <p className="text-xs text-muted-foreground">{sessionEndLabel(s.endReason, s.lastHeartbeatAt)}{s.refundedCredits ? ` · ${fmtNum(s.refundedCredits)} credits refunded` : ""}</p>
                  </div>
                  <span className="shrink-0 tabular-nums">{fmtNum(s.secondsBilled - (s.refundedCredits ?? 0))} <span className="text-xs text-muted-foreground">credits</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardTitle>Recent credit changes</CardTitle>
          {p.credits.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No credit changes yet.</p>
          ) : (
            <ul className="mt-3 divide-y text-sm">
              {p.credits.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">{ledgerReasonLabel(c.reason)}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(c.createdAt)} · {c.bucket === "monthly" ? "monthly credits" : "purchased credits"}</p>
                  </div>
                  <span className={`shrink-0 tabular-nums ${c.delta < 0 ? "text-muted-foreground" : "font-medium"}`}>{c.delta < 0 ? "−" : "+"}{fmtNum(Math.abs(c.delta))}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Spending on live sessions is listed per session. 1 credit = 1 second.</p>
        </Card>
      </div>
    </section>
  );
}
