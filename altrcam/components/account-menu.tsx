"use client";
import { useState } from "react";
import { useClerk, useUser } from "@clerk/nextjs";
import { User as UserIcon } from "lucide-react";
import { NavLinks } from "@/components/nav-links";
import { useDisclosure } from "@/components/use-disclosure";
import { ACCOUNT_LINKS } from "@/lib/nav";

const ITEM = "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted";

/**
 * Signs out through Clerk and lands on the home page. Uses Clerk hooks, so it may only be rendered for a signed-in visitor:
 * being signed in implies Clerk is configured, which is exactly when the root layout mounts ClerkProvider.
 */
export function SignOutItem({ className = ITEM }: { className?: string }) {
  const { signOut } = useClerk();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={className} disabled={busy} onClick={async () => {
      setBusy(true);
      try { await signOut({ redirectUrl: "/" }); } finally { setBusy(false); }
    }}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

/**
 * The avatar menu: Dashboard, Studio, Billing, Settings, Sign out, the same in the marketing header and the signed-in shell.
 * The picture and name come from Clerk once it has loaded in the browser, falling back to what the server passed (the users row).
 * Signed-in visitors only (see SignOutItem).
 */
export function AccountMenu({ name, email, avatarUrl }: { name?: string; email?: string; avatarUrl?: string | null }) {
  const { user } = useUser();
  const d = useDisclosure();
  const image = user?.imageUrl || avatarUrl || null;
  const who = user?.fullName || name || user?.primaryEmailAddress?.emailAddress || email || "";
  return (
    <div ref={d.rootRef} className="relative">
      <button ref={d.buttonRef} type="button" onClick={d.toggle} aria-expanded={d.open} aria-controls={d.panelId} aria-label="Account menu"
        className="grid h-9 w-9 place-items-center overflow-hidden rounded-full border bg-muted hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary">
        {/* eslint-disable-next-line @next/next/no-img-element -- a 36px avatar from Clerk's CDN; nothing to optimise */}
        {image ? <img src={image} alt="" className="h-full w-full object-cover" /> : <UserIcon className="h-4 w-4 text-muted-foreground" aria-hidden />}
      </button>
      <div ref={d.panelRef} id={d.panelId} hidden={!d.open} onClick={d.onPanelClick} data-testid="account-menu"
        className="absolute right-0 z-40 mt-2 w-56 rounded-lg border bg-card p-1 shadow-xl">
        {who && <p className="truncate px-3 py-2 text-xs text-muted-foreground">{who}</p>}
        <ul>
          <NavLinks links={ACCOUNT_LINKS} list className={ITEM} activeClass="text-primary" />
          <li className="mt-1 border-t pt-1"><SignOutItem /></li>
        </ul>
      </div>
    </div>
  );
}
