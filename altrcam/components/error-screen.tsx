"use client";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

/**
 * What app/error.tsx and app/global-error.tsx show: a plain apology, Retry (re-renders the failed part), and where to get help.
 * The reference is Next's error digest, which matches the server log entry, so support can find what happened.
 */
export function ErrorScreen({ reset, digest }: { reset: () => void; digest?: string }) {
  return (
    <main id="content" className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <Logo />
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-muted-foreground">This page couldn&apos;t be shown. Try again; if it keeps happening, <Link href="/contact" className="text-primary underline">contact us</Link>.</p>
      {digest && <p className="text-xs text-muted-foreground">Reference: <code>{digest}</code></p>}
      <div className="mt-2 flex gap-3">
        <Button variant="gradient" onClick={reset}>Retry</Button>
        <Link href="/" className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">Home</Link>
      </div>
    </main>
  );
}
