import Link from "next/link";
import { cookies } from "next/headers";
import { UserButton } from "@clerk/nextjs";
import { Logo } from "@/components/logo";
import { NotificationBell } from "@/components/notification-bell";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { listNotifications, unreadCount } from "@/lib/notifications";
import { isAdmin } from "@/lib/api";
import { claimReferral } from "@/lib/referrals";
import { REFERRAL } from "@/lib/plans";

const nav = [
  ["Dashboard", "/dashboard"], ["Studio", "/studio"], ["History", "/history"],
  ["Presets", "/presets"], ["Referrals", "/referrals"], ["Billing", "/billing"], ["Support", "/support"], ["Settings", "/settings"],
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAppUser();

  // Attribute a referral from the cookie set by /?ref=. Cheap no-op unless the account is new and unclaimed.
  const refCode = (await cookies()).get(REFERRAL.cookie)?.value;
  if (refCode && !user.referredBy && Date.now() - user.createdAt.getTime() <= REFERRAL.claimWindowDays * 86_400_000) {
    await claimReferral(db(), user.id, refCode).catch((e) => console.error("[referral] claim failed", e));
  }
  const [items, unread, admin] = await Promise.all([listNotifications(db(), user.id), unreadCount(db(), user.id), isAdmin(user.id)]);
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Logo href="/dashboard" />
          <nav aria-label="Main" className="hidden items-center gap-1 text-sm md:flex">
            {nav.map(([l, h]) => <Link key={h} href={h} className="rounded-md px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground">{l}</Link>)}
            {admin && <Link href="/admin" className="rounded-md px-3 py-2 text-accent hover:bg-muted">Admin</Link>}
          </nav>
          <div className="flex items-center gap-2">
            <NotificationBell unread={unread} initial={items.map((n) => ({ ...n, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() }))} />
            <UserButton />
          </div>
        </div>
        <nav aria-label="Main mobile" className="flex gap-1 overflow-x-auto border-t px-2 py-1 text-sm md:hidden">
          {nav.map(([l, h]) => <Link key={h} href={h} className="shrink-0 rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted">{l}</Link>)}
          {admin && <Link href="/admin" className="shrink-0 rounded-md px-3 py-1.5 text-accent">Admin</Link>}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">Powered by Lucy 2.5 from Decart</footer>
    </div>
  );
}
