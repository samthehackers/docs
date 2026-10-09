import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonClass } from "@/components/ui/button";
import { accountsOpen } from "@/lib/config";
import { viewerId } from "@/lib/viewer";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const userId = await viewerId();
  const open = accountsOpen();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Logo />
          <nav className="flex items-center gap-1 text-sm sm:gap-2">
            <Link href="/how-it-works" className="hidden px-3 py-2 text-muted-foreground hover:text-foreground sm:inline">How it works</Link>
            <Link href="/pricing" className="hidden px-2 py-2 text-muted-foreground hover:text-foreground min-[400px]:inline sm:px-3">Pricing</Link>
            <Link href="/faq" className="hidden px-3 py-2 text-muted-foreground hover:text-foreground sm:inline">FAQ</Link>
            {userId ? (
              <Link href="/dashboard" className={buttonClass({ variant: "gradient", size: "sm" })}>Dashboard</Link>
            ) : open ? (
              <>
                <Link href="/sign-in" className="px-2 py-2 text-muted-foreground hover:text-foreground sm:px-3">Sign in</Link>
                <Link href="/sign-up" className={buttonClass({ variant: "gradient", size: "sm" })}>Get started</Link>
              </>
            ) : null}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
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
