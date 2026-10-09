import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreditForm, PlanForm, TicketReply } from "@/components/admin/forms";
import { PlanLimitsForm } from "@/components/admin/plan-limits-form";
import { db } from "@/lib/db";
import { adminAudit, adminPayments, adminPlans, adminSessions, adminTickets, adminWebhooks, kpis, productLabel, searchUsers, userDetail } from "@/lib/admin";
import { requireAdminPage } from "@/lib/session-user";
import { ledgerBalance } from "@/lib/credits";
import { money, relativeTime } from "@/lib/utils";

export const metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const TABS = ["overview", "users", "plans", "payments", "sessions", "tickets", "webhooks", "audit"] as const;

export default async function Admin({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; user?: string }> }) {
  // The layout also redirects, but it is not a boundary: Next renders layout and page in parallel. Check here, before
  // anything below is created, and again inside every data function (lib/admin.ts).
  await requireAdminPage();
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? sp.tab! : "overview";
  return (
    <div className="space-y-6">
      <nav aria-label="Admin" className="flex flex-wrap gap-1 text-sm">
        {TABS.map((t) => <Link key={t} href={`/admin?tab=${t}`} className={`rounded-md px-3 py-1.5 capitalize ${t === tab ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{t}</Link>)}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "users" && <Users q={sp.q ?? ""} userId={sp.user} />}
      {tab === "plans" && <PlanLimits />}
      {tab === "payments" && <Payments />}
      {tab === "sessions" && <Sessions />}
      {tab === "tickets" && <Tickets />}
      {tab === "webhooks" && <Webhooks />}
      {tab === "audit" && <Audit />}
    </div>
  );
}

const Table = ({ head, children }: { head: string[]; children: React.ReactNode }) => (
  <div className="overflow-x-auto rounded-lg border bg-card"><table className="w-full text-left text-sm"><thead className="text-xs text-muted-foreground"><tr>{head.map((h) => <th key={h} className="p-3">{h}</th>)}</tr></thead><tbody className="divide-y">{children}</tbody></table></div>
);

async function Overview() {
  const k = await kpis();
  const mrr = Object.entries(k.mrr).map(([c, v]) => money(v, c)).join(" + ") || "—";
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card><CardTitle>MRR</CardTitle><p className="mt-2 text-3xl font-bold">{mrr}</p></Card>
      <Card><CardTitle>Active users (30d)</CardTitle><p className="mt-2 text-3xl font-bold">{k.activeUsers30d}</p></Card>
      <Card><CardTitle>Realtime seconds today</CardTitle><p className="mt-2 text-3xl font-bold">{k.realtimeSecondsToday.toLocaleString()}</p></Card>
      <Card><CardTitle>Users / Pro</CardTitle><p className="mt-2 text-3xl font-bold">{k.totalUsers} / {k.proUsers}</p></Card>
    </div>
  );
}

async function Users({ q, userId }: { q: string; userId?: string }) {
  if (userId) {
    const d = await userDetail(userId);
    if (!d) return <p>User not found.</p>;
    const bal = await ledgerBalance(db(), userId);
    const { user: u } = d;
    return (
      <div className="space-y-6">
        <Link href="/admin?tab=users" className="text-sm text-muted-foreground hover:underline">← All users</Link>
        <Card className="space-y-4">
          <div><h2 className="text-xl font-bold">{u.name || u.email}</h2><p className="text-sm text-muted-foreground">{u.email} · {u.id}</p></div>
          <div className="flex flex-wrap gap-6 text-sm"><span>Plan <Badge>{u.plan}</Badge> ({u.planStatus})</span><span>Credits {bal.total} ({bal.monthly} monthly, {bal.purchased} purchased)</span></div>
          <PlanForm userId={u.id} plan={u.plan} /><CreditForm userId={u.id} />
        </Card>
        <h3 className="font-semibold">Sessions</h3>
        <Table head={["Started", "Seconds", "Ended", "Reason"]}>{d.sessions.map((s) => <tr key={s.id}><td className="p-3">{relativeTime(s.startedAt)}</td><td className="p-3">{s.secondsBilled}</td><td className="p-3">{s.endedAt ? relativeTime(s.endedAt) : "live"}</td><td className="p-3">{s.endReason ?? "—"}</td></tr>)}</Table>
        <h3 className="font-semibold">Payments</h3>
        <Table head={["Date", "Item", "Amount", "Status", "Ref"]}>{d.payments.map((p) => <tr key={p.id}><td className="p-3">{relativeTime(p.createdAt)}</td><td className="p-3">{productLabel(p.product)}</td><td className="p-3">{money(p.amountMinor, p.currency)}</td><td className="p-3">{p.status}</td><td className="p-3 font-mono text-xs">{p.reference}</td></tr>)}</Table>
      </div>
    );
  }
  const rows = await searchUsers(q);
  return (
    <div className="space-y-4">
      <form role="search" className="flex gap-2"><input type="hidden" name="tab" value="users" /><input name="q" defaultValue={q} placeholder="Search name, email or id" aria-label="Search users" className="h-10 w-full max-w-sm rounded-md border bg-muted/40 px-3 text-sm" /><button className="rounded-md border px-4 text-sm">Search</button></form>
      <Table head={["User", "Plan", "Joined", ""]}>{rows.map((u) => <tr key={u.id}><td className="p-3"><p className="font-medium">{u.name || "—"}</p><p className="text-xs text-muted-foreground">{u.email}</p></td><td className="p-3">{u.plan}</td><td className="p-3">{relativeTime(u.createdAt)}</td><td className="p-3"><Link className="text-primary hover:underline" href={`/admin?tab=users&user=${encodeURIComponent(u.id)}`}>Open</Link></td></tr>)}</Table>
    </div>
  );
}

async function Payments() {
  const rows = await adminPayments();
  return <Table head={["Date", "Provider", "Item", "Amount", "Status", "User", "Ref"]}>{rows.map((p) => <tr key={p.id}><td className="p-3">{relativeTime(p.createdAt)}</td><td className="p-3">{p.provider}</td><td className="p-3">{productLabel(p.product)}</td><td className="p-3">{money(p.amountMinor, p.currency)}</td><td className="p-3">{p.status}</td><td className="p-3 text-xs">{p.userId ?? "anonymised"}</td><td className="p-3 font-mono text-xs">{p.reference}</td></tr>)}</Table>;
}

async function Sessions() {
  const rows = await adminSessions();
  return <Table head={["Started", "User", "Billed s", "FPS", "RTT ms", "Ended"]}>{rows.map((s) => <tr key={s.id}><td className="p-3">{relativeTime(s.startedAt)}</td><td className="p-3 text-xs">{s.userId}</td><td className="p-3">{s.secondsBilled}</td><td className="p-3">{s.avgFps?.toFixed(0) ?? "—"}</td><td className="p-3">{s.avgLatencyMs?.toFixed(0) ?? "—"}</td><td className="p-3">{s.endedAt ? s.endReason : "live"}</td></tr>)}</Table>;
}

async function Tickets() {
  const rows = await adminTickets();
  return (
    <div className="space-y-4">{rows.length === 0 && <Card className="text-center text-sm text-muted-foreground">No tickets.</Card>}
      {rows.map((t) => (
        <Card key={t.id} className="space-y-3">
          <div className="flex items-center justify-between"><p className="font-medium">{t.subject}</p><Badge>{t.status}</Badge></div>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{t.body}</p><p className="text-xs text-muted-foreground">{t.userId} · {relativeTime(t.createdAt)}</p>
          {t.adminReply && <p className="whitespace-pre-wrap rounded-md border-l-2 border-primary bg-muted/40 p-3 text-sm">{t.adminReply}</p>}
          <TicketReply id={t.id} />
        </Card>))}</div>
  );
}

async function Webhooks() {
  const rows = await adminWebhooks();
  return <Table head={["Received", "Provider", "Type", "Event id"]}>{rows.map((w) => <tr key={w.id}><td className="p-3">{relativeTime(w.at)}</td><td className="p-3">{w.provider}</td><td className="p-3">{w.type}</td><td className="p-3 font-mono text-xs">{w.eventId.slice(0, 48)}</td></tr>)}</Table>;
}

async function Audit() {
  const rows = await adminAudit();
  return <Table head={["When", "Actor", "Action", "Target", "Meta"]}>{rows.map((a) => <tr key={a.id}><td className="p-3">{relativeTime(a.createdAt)}</td><td className="p-3 text-xs">{a.actorId}</td><td className="p-3">{a.action}</td><td className="p-3 text-xs">{a.target}</td><td className="p-3 font-mono text-xs">{JSON.stringify(a.meta)}</td></tr>)}</Table>;
}

async function PlanLimits() {
  const { plans, customised: custom } = await adminPlans();
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">Changes apply to new sessions, refills and purchases within about 15 seconds and are written to the audit log. Lowering a limit doesn't remove anything a user already has. Prices are set separately in environment variables.</p>
      {(["FREE", "PRO", "LIFETIME"] as const).map((k) => (
        <Card key={k}><PlanLimitsForm plan={k} label={plans[k].label} customised={custom.has(k)} value={{ monthlyCredits: plans[k].monthlyCredits, maxSessionSeconds: plans[k].maxSessionSeconds, maxResolution: plans[k].maxResolution, presets: plans[k].presets, historyDays: plans[k].historyDays, clipRecording: plans[k].clipRecording }} /></Card>
      ))}
    </div>
  );
}
