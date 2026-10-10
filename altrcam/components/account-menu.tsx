"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AccountMenu({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await createClient().auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3">
      <span className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline" title={email}>{email}</span>
      <button type="button" onClick={signOut} disabled={busy} className="rounded-md border px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50">
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
