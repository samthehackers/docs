"use client";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { SignOutItem } from "@/components/account-menu";
import { NavLinks } from "@/components/nav-links";
import { buttonClass } from "@/components/ui/button";
import { useDisclosure } from "@/components/use-disclosure";
import { ACCOUNT_LINKS, PAGE_LINKS, type HeaderAuth } from "@/lib/nav";

const ITEM = "block rounded-md px-3 py-2.5 text-sm hover:bg-muted focus-visible:bg-muted";

/**
 * The marketing header's menu below the md breakpoint: the page links, then what the desktop header offers for this visitor
 * (`auth`, see headerAuth in lib/nav.ts). Clerk is only touched for a signed-in visitor (Sign out), so the menu renders on a
 * deployment with no Clerk configured.
 */
export function SiteMenu({ auth }: { auth: HeaderAuth }) {
  const d = useDisclosure();
  return (
    <div ref={d.rootRef} className="md:hidden">
      <button ref={d.buttonRef} type="button" onClick={d.toggle} aria-expanded={d.open} aria-controls={d.panelId} aria-label="Menu"
        className="grid h-10 w-10 place-items-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary">
        {d.open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
      </button>
      <div ref={d.panelRef} id={d.panelId} hidden={!d.open} onClick={d.onPanelClick} data-testid="site-menu"
        className="absolute inset-x-0 top-full border-b bg-background px-4 pb-4 pt-2 shadow-lg">
        <nav aria-label="Menu">
          <ul>
            <NavLinks links={PAGE_LINKS} list className={ITEM} activeClass="text-primary" />
          </ul>
          {auth === "signed-in" && (
            <ul className="mt-2 border-t pt-2">
              <NavLinks links={ACCOUNT_LINKS} list className={ITEM} activeClass="text-primary" />
              <li><SignOutItem className={`${ITEM} w-full text-left`} /></li>
            </ul>
          )}
          {(auth === "open" || auth === "sign-in-only") && (
            <div className="mt-2 flex flex-col gap-2 border-t pt-3">
              <Link href="/sign-in" className={buttonClass({ variant: "ghost", className: "w-full" })}>Sign in</Link>
              {auth === "open" && <Link href="/sign-up" className={buttonClass({ variant: "gradient", className: "w-full" })}>Get started free</Link>}
            </div>
          )}
        </nav>
      </div>
    </div>
  );
}
