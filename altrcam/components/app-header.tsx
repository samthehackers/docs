import { Logo } from "@/components/logo";
import { NavLinks } from "@/components/nav-links";
import type { NavLink } from "@/lib/nav";

/**
 * The signed-in shell's header. The inline nav needs about 900px with the Admin link, so it only shows from lg (1024px); below
 * that the same links scroll in a row under the bar. The right-hand cluster (bell, account menu) never shrinks, so it can't be
 * pushed off-screen (an audit saw that happen at 768-872px when the inline nav started at md). `bell` is null when the
 * notifications couldn't be loaded: the header degrades instead of failing the page.
 */
export function AppHeader({ links, bell, account }: { links: readonly (NavLink & { className?: string })[]; bell: React.ReactNode; account: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        <Logo href="/dashboard" />
        <nav aria-label="Main" className="hidden min-w-0 items-center gap-0.5 text-sm lg:flex">
          <NavLinks links={links} className="rounded-md px-2.5 py-2 text-muted-foreground hover:bg-muted hover:text-foreground" activeClass="bg-muted text-foreground" />
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {bell}
          {account}
        </div>
      </div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto border-t px-2 py-1 text-sm lg:hidden">
        <NavLinks links={links} className="shrink-0 rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted" activeClass="bg-muted text-foreground" />
      </nav>
    </header>
  );
}
