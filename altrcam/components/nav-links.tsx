"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isCurrent, type NavLink } from "@/lib/nav";

/**
 * Links that mark the page being shown with aria-current="page" (styled with `activeClass`). Client-only because it reads the
 * pathname. `list` wraps each link in an <li> for use inside a <ul>.
 */
export function NavLinks({ links, className, activeClass, list = false }: {
  links: readonly (NavLink & { className?: string })[]; className?: string; activeClass?: string; list?: boolean;
}) {
  const pathname = usePathname();
  return links.map((l) => {
    const current = isCurrent(pathname, l.href);
    const link = (
      <Link key={l.href} href={l.href} aria-current={current ? "page" : undefined} className={cn(className, l.className, current && activeClass)}>
        {l.label}
      </Link>
    );
    return list ? <li key={l.href}>{link}</li> : link;
  });
}
