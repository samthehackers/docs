"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProductId } from "@/lib/plans";

export function CheckoutButton({ product, label, variant = "gradient", crypto = false, className }: {
  product: ProductId; label: string; variant?: "gradient" | "outline"; crypto?: boolean; className?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go(provider: "paystack" | "nowpayments") {
    setBusy(provider); setErr(null);
    const r = await fetch("/api/payments/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, provider }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.url) { window.location.href = j.url; return; }
    setErr(j.error ?? "Couldn't start checkout"); setBusy(null);
  }
  return (
    <div className={className}>
      <div className="flex gap-2">
        <Button variant={variant} className="flex-1" disabled={!!busy} onClick={() => go("paystack")}>
          {busy === "paystack" && <Loader2 className="h-4 w-4 animate-spin" />} {label}
        </Button>
        {crypto && <Button variant="outline" disabled={!!busy} onClick={() => go("nowpayments")} aria-label={`${label} with crypto`}>
          {busy === "nowpayments" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Crypto"}
        </Button>}
      </div>
      {err && <p role="alert" className="mt-2 text-xs text-destructive">{err}</p>}
    </div>
  );
}

export function CancelButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function cancel() {
    if (!confirm("Cancel your subscription? Pro stays active until the end of the paid period.")) return;
    setBusy(true);
    const r = await fetch("/api/payments/cancel", { method: "POST" });
    setMsg(r.ok ? "Cancelled. You keep Pro until your period ends." : "Couldn't cancel. Contact support.");
    setBusy(false);
  }
  return <div><Button variant="outline" size="sm" onClick={cancel} disabled={busy}>Cancel subscription</Button>{msg && <p role="status" className="mt-2 text-xs text-muted-foreground">{msg}</p>}</div>;
}
