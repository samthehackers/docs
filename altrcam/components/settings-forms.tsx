"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

export function NotifyToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  async function change(v: boolean) {
    setOn(v);
    const r = await fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notifyEmail: v }) });
    if (!r.ok) setOn(!v);
  }
  return <label className="flex items-center gap-3 text-sm"><input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={on} onChange={(e) => change(e.target.checked)} /> Email me receipts and low-credit alerts</label>;
}

export function DeleteAccount() {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const router = useRouter();
  async function del() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: text }) });
    // The login is gone server-side; also drop the session cookies in this browser.
    if (r.ok) { await createClient().auth.signOut().catch(() => {}); router.push("/"); router.refresh(); return; }
    setErr((await r.json().catch(() => ({}))).error ?? "Couldn't delete"); setBusy(false);
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">This cancels subscriptions, deletes your files, presets, history and sessions, and removes your login. Payment records are kept anonymised for accounting. It can't be undone.</p>
      <label className="block text-sm">Type <b>DELETE</b> to confirm<Input value={text} onChange={(e) => setText(e.target.value)} className="mt-1 max-w-xs" autoComplete="off" /></label>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <Button variant="destructive" disabled={text !== "DELETE" || busy} onClick={del}>Delete my account</Button>
    </div>
  );
}
