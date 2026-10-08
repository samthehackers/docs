"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";

export function TicketForm() {
  const router = useRouter();
  const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = await fetch("/api/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject, body }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setSubject(""); setBody(""); setMsg("Sent. We'll reply here."); router.refresh(); } else setMsg(j.error ?? "Couldn't send");
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">Subject<Input required minLength={3} maxLength={140} value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1" /></label>
      <label className="block text-sm">How can we help?<Textarea required minLength={10} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} className="mt-1 min-h-[140px]" /></label>
      <Button type="submit" variant="gradient" disabled={busy}>Send ticket</Button>
      {msg && <p role="status" className="text-sm text-muted-foreground">{msg}</p>}
    </form>
  );
}
