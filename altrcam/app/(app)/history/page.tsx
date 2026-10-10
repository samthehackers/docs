import Link from "next/link";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { Card } from "@/components/ui/card";
import { Select, Input } from "@/components/ui/input";
import { Button, buttonClass } from "@/components/ui/button";
import { HistoryActions } from "@/components/history-actions";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { transformations } from "@/db/schema";
import { getPlan } from "@/lib/plan-config";
import { signedReadUrl } from "@/lib/storage";
import { relativeTime } from "@/lib/utils";

export const metadata = { title: "History" };
export const dynamic = "force-dynamic";
const PAGE = 12;
const TYPES = ["face", "background", "outfit", "style", "custom"];

export default async function History({ searchParams }: { searchParams: Promise<{ type?: string; from?: string; to?: string; page?: string }> }) {
  const user = await requireAppUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const days = (await getPlan(user.plan)).historyDays;
  const conds = [eq(transformations.userId, user.id)];
  if (days) conds.push(gte(transformations.createdAt, new Date(Date.now() - days * 86_400_000)));
  if (sp.type && TYPES.includes(sp.type)) conds.push(eq(transformations.type, sp.type));
  const from = sp.from ? new Date(sp.from) : null, to = sp.to ? new Date(sp.to + "T23:59:59Z") : null;
  if (from && !isNaN(+from)) conds.push(gte(transformations.createdAt, from));
  if (to && !isNaN(+to)) conds.push(lte(transformations.createdAt, to));

  const [rows, [{ n }]] = await Promise.all([
    db().select().from(transformations).where(and(...conds)).orderBy(desc(transformations.createdAt)).limit(PAGE).offset((page - 1) * PAGE),
    db().select({ n: count() }).from(transformations).where(and(...conds)),
  ]);
  // A storage hiccup (or storage not configured) shows a blank tile instead of failing the whole page.
  const thumbs = await Promise.all(rows.map((r) => (r.thumbnailUrl ? signedReadUrl(r.thumbnailUrl).catch(() => null) : null)));
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const filtered = Boolean(sp.type || sp.from || sp.to);
  const qs = (p: number) => { const q = new URLSearchParams(); if (sp.type) q.set("type", sp.type); if (sp.from) q.set("from", sp.from); if (sp.to) q.set("to", sp.to); q.set("page", String(p)); return `?${q}`; };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">History</h1>
        <p className="text-sm text-muted-foreground">{days ? `Your plan keeps history for ${days} days.` : "Your plan keeps history forever."}</p>
        <p className="text-sm text-muted-foreground">History holds the stills you save with the Snapshot button while you&apos;re live in the Studio. Live sessions themselves aren&apos;t stored here; see your usage on the <Link href="/dashboard" className="text-primary underline">Dashboard</Link>.</p>
      </div>
      <form className="flex flex-wrap items-end gap-3" role="search">
        <label className="text-xs text-muted-foreground">Type<Select name="type" defaultValue={sp.type ?? ""} className="mt-1 w-40"><option value="">All</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select></label>
        <label className="text-xs text-muted-foreground">From<Input type="date" name="from" defaultValue={sp.from} className="mt-1" /></label>
        <label className="text-xs text-muted-foreground">To<Input type="date" name="to" defaultValue={sp.to} className="mt-1" /></label>
        <Button type="submit" variant="outline">Filter</Button>
      </form>
      {rows.length === 0 ? (
        <Card className="space-y-2 py-12 text-center text-muted-foreground">
          {filtered ? <p>No saved items match these filters.</p> : (
            <>
              <p>Nothing saved yet.</p>
              <p className="text-sm">Snapshots are saved manually: press Snapshot in the <Link href="/studio" className="text-primary underline">Studio</Link> while you&apos;re live and the still lands here. A session you don&apos;t snapshot leaves nothing in History.</p>
            </>
          )}
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r, i) => (
            <li key={r.id} className="min-w-0"><Card className="overflow-hidden p-0">
              {thumbs[i] ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={thumbs[i]!} alt={r.title} className="aspect-video w-full object-cover" loading="lazy" /> : <div className="aspect-video bg-muted" />}
              <div className="space-y-2 p-4">
                <p className="truncate font-medium">{r.title}</p>
                <p className="text-xs text-muted-foreground">{r.type} · {relativeTime(r.createdAt)}</p>
                {r.prompt && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Prompt</summary>
                    <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{r.prompt}</p>
                  </details>
                )}
                <HistoryActions id={r.id} />
              </div>
            </Card></li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label="Pagination" className="flex items-center justify-center gap-3 text-sm">
          {page > 1 && <Link className={buttonClass({ variant: "outline", size: "sm" })} href={qs(page - 1)}>Previous</Link>}
          <span className="text-muted-foreground">Page {page} of {pages}</span>
          {page < pages && <Link className={buttonClass({ variant: "outline", size: "sm" })} href={qs(page + 1)}>Next</Link>}
        </nav>
      )}
    </div>
  );
}
