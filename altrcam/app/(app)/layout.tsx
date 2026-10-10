import { cookies } from "next/headers";
import { AccountMenu } from "@/components/account-menu";
import { AppHeader } from "@/components/app-header";
import { NotificationBell } from "@/components/notification-bell";
import { SkipLink } from "@/components/skip-link";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { listNotifications, unreadCount } from "@/lib/notifications";
import { isAdmin } from "@/lib/api";
import { claimReferral } from "@/lib/referrals";
import { parseRefCookie } from "@/lib/referral-cookie";
import { REFERRAL } from "@/lib/plans";
import { ADMIN_LINK, APP_LINKS } from "@/lib/nav";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAppUser();

  // Attribute a referral from the cookie set by /?ref=. Only runs for a brand-new, unclaimed account (one
  // indexed lookup on document loads in that first day); claimReferral re-checks everything. The cookie can't
  // be cleared from a server component, so it lingers harmlessly once the account is claimed or too old.
  const ref = parseRefCookie((await cookies()).get(REFERRAL.cookie)?.value);
  if (ref && !user.referredBy && Date.now() - user.createdAt.getTime() <= REFERRAL.claimWindowDays * 86_400_000) {
    await claimReferral(db(), user.id, ref.code, { clickedAt: ref.clickedAt }).catch((e) => console.error("[referral] claim failed", e));
  }
  const [items, unread, admin] = await Promise.all([listNotifications(db(), user.id), unreadCount(db(), user.id), isAdmin(user.id)]);
  const links = admin ? [...APP_LINKS, { ...ADMIN_LINK, className: "text-accent" }] : APP_LINKS;
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <AppHeader
        links={links}
        bell={<NotificationBell unread={unread} initial={items.map((n) => ({ ...n, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() }))} />}
        account={<AccountMenu name={user.name} email={user.email} avatarUrl={user.avatarUrl} />}
      />
      <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">Powered by Lucy 2.5 from Decart</footer>
    </div>
  );
}
