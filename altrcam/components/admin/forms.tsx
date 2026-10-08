"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, error: r.ok ? null : ((await r.json().catch(() => ({}))).error as string | undefined) ?? "Failed" };
}

export function CreditForm({ userId }: { userId: string }) {
  const router = useRouter();
  const [amount, setAmount] = useState("100"); const [reason, setReason] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const r = await post("/api/admin/credits", { userId, amount: Number(amount), reason });
    setMsg(r.ok ? "Done" : r.error); if (r.ok) { setReason(""); router.refresh(); }
  }
  return (
    <form onSubmit={go} className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-muted-foreground">Credits (negative revokes)<Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-40" /></label>
      <label className="text-xs text-muted-foreground">Reason<Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 w-60" /></label>
      <Button type="submit" variant="outline">Apply</Button>{msg && <span role="status" className="text-xs">{msg}</span>}
    </form>
  );
}

export function PlanForm({ userId, plan }: { userId: string; plan: string }) {
  const router = useRouter();
  const [v, setV] = useState(plan); const [msg, setMsg] = useState<string | null>(null);
  async function go() { const r = await post("/api/admin/plan", { userId, plan: v }); setMsg(r.ok ? "Done" : r.error); if (r.ok) router.refresh(); }
  return <div className="flex items-center gap-2"><Select value={v} onChange={(e) => setV(e.target.value)} className="w-40" aria-label="Plan"><option>FREE</option><option>PRO</option><option>LIFETIME</option></Select><Button variant="outline" onClick={go}>Change plan</Button>{msg && <span role="status" className="text-xs">{msg}</span>}</div>;
}

export function TicketReply({ id }: { id: number }) {
  const router = useRouter();
  const [reply, setReply] = useState(""); const [msg, setMsg] = useState<string | null>(null);
  async function go(e: React.FormEvent) { e.preventDefault(); const r = await post("/api/admin/tickets", { id, reply }); setMsg(r.ok ? "Sent" : r.error); if (r.ok) { setReply(""); router.refresh(); } }
  return <form onSubmit={go} className="space-y-2"><Textarea required value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply" /><Button type="submit" size="sm">Send reply</Button>{msg && <span role="status" className="ml-2 text-xs">{msg}</span>}</form>;
}
