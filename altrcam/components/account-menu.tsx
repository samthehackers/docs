"use client";

import { useState } from "react";

/**
 * The signed-in header's email and Sign out button. Sign out is a form POST to /auth/sign-out, which clears the session
 * on the server, so it works even if it is clicked before the page's JavaScript has loaded.
 */
export function AccountMenu({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <form action="/auth/sign-out" method="post" onSubmit={() => setBusy(true)} className="flex items-center gap-3">
      <span className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline" title={email}>{email}</span>
      <button type="submit" disabled={busy} className="rounded-md border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50">
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </form>
  );
}
