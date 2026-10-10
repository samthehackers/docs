import Link from "next/link";
import { AccountMenu } from "@/components/account-menu";
import { Logo } from "@/components/logo";
import { NavLinks } from "@/components/nav-links";
import { SiteMenu } from "@/components/site-menu";
import { SkipLink } from "@/components/skip-link";
import { buttonClass } from "@/components/ui/button";
import { accountsOpen, signInOpen } from "@/lib/config";
import { headerAuth, PAGE_LINKS, type HeaderAuth } from "@/lib/nav";
import { viewerId } from "@/lib/viewer";

/** The header's right-hand side from md up. The account menu (Clerk hooks) only exists for a signed-in visitor. */
function HeaderActions({ auth }: { auth: HeaderAuth }) {
  if (auth === "signed-in") {
    return (
      <>
        <Link href="/dashboard" className={buttonClass({ variant: "gradient", size: "sm" })}>Dashboard</Link>
        <AccountMenu />
      </>
    );
  }
  if (auth === "closed") return null; // the pages say sign-up isn't open; there is nothing to sign into
  return (
    <>
      <Link href="/sign-in" className={buttonClass({ variant: "ghost", size: "sm" })}>Sign in</Link>
      {auth === "open" && <Link href="/sign-up" className={buttonClass({ variant: "gradient", size: "sm" })}>Get started free</Link>}
    </>
  );
}

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const auth = headerAuth({ signedIn: (await viewerId()) !== null, accountsOpen: accountsOpen(), signInOpen: signInOpen() });
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4">
          <Logo />
          <div className="hidden items-center gap-2 text-sm md:flex">
            <nav aria-label="Main" className="flex items-center">
              <NavLinks links={PAGE_LINKS} className="px-3 py-2 text-muted-foreground hover:text-foreground" activeClass="text-foreground" />
            </nav>
            <HeaderActions auth={auth} />
          </div>
          <SiteMenu auth={auth} />
        </div>
      </header>
      <main id="content" className="flex-1">{children}</main>
      <footer className="border-t py-8 text-center text-xs text-muted-foreground">
        <nav aria-label="Footer" className="mb-3 flex flex-wrap justify-center gap-x-4 gap-y-2 px-4">
          <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
          <Link href="/how-it-works" className="hover:text-foreground">How it works</Link>
          <Link href="/faq" className="hover:text-foreground">FAQ</Link>
          <Link href="/terms" className="hover:text-foreground">Terms</Link>
          <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
          <Link href="/contact" className="hover:text-foreground">Contact</Link>
        </nav>
        <p>© {new Date().getFullYear()} AltrCam · altrcam.com</p>
        <p className="mt-1">Powered by Lucy 2.5 from Decart</p>
      </footer>
    </div>
  );
}
