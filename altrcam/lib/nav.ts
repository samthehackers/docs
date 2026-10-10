/**
 * The site's navigation entries, in one plain module so server layouts and client menus share them (a constant exported from a
 * "use client" file is not usable as a value on the server). No imports: client components include this file.
 */
export interface NavLink { label: string; href: string }

/** Public pages, in the marketing header and its mobile menu. */
export const PAGE_LINKS: readonly NavLink[] = [
  { label: "How it works", href: "/how-it-works" },
  { label: "Pricing", href: "/pricing" },
  { label: "FAQ", href: "/faq" },
];

/** The account menu (avatar), the same in the marketing header and the signed-in shell; "Sign out" follows them. */
export const ACCOUNT_LINKS: readonly NavLink[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Studio", href: "/studio" },
  { label: "Billing", href: "/billing" },
  { label: "Settings", href: "/settings" },
];

/** The signed-in shell's main navigation. */
export const APP_LINKS: readonly NavLink[] = [
  { label: "Dashboard", href: "/dashboard" }, { label: "Studio", href: "/studio" }, { label: "History", href: "/history" },
  { label: "Presets", href: "/presets" }, { label: "Referrals", href: "/referrals" }, { label: "Billing", href: "/billing" },
  { label: "Support", href: "/support" }, { label: "Settings", href: "/settings" },
];
export const ADMIN_LINK: NavLink = { label: "Admin", href: "/admin" };

/** Whether `href` is the page being shown (or a page under it): /billing is current on /billing/success too. */
export function isCurrent(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * What the marketing header offers a visitor:
 *  - "signed-in": Dashboard and the account menu;
 *  - "open": Sign in and Get started free (accountsOpen() in lib/config.ts);
 *  - "sign-in-only": Sign in, because sign-in works but the owner has switched sign-up off (SIGNUPS_OPEN);
 *  - "closed": neither, the pages say sign-up isn't open.
 */
export type HeaderAuth = "signed-in" | "open" | "sign-in-only" | "closed";
export function headerAuth(s: { signedIn: boolean; accountsOpen: boolean; signInOpen: boolean }): HeaderAuth {
  if (s.signedIn) return "signed-in";
  if (s.accountsOpen) return "open";
  return s.signInOpen ? "sign-in-only" : "closed";
}
