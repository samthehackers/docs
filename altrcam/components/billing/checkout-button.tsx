"use client";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PayProvider, ProductId } from "@/lib/plans";

/** One way to pay for a product: the provider and the button text, which carries the price that provider charges. */
export interface PayOption { provider: PayProvider; label: string }

export function CheckoutButton({ product, options, variant = "gradient", className }: {
  product: ProductId; options: PayOption[]; variant?: "gradient" | "outline"; className?: string;
}) {
  const [busy, setBusy] = useState<PayProvider | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go(provider: PayProvider) {
    setBusy(provider); setErr(null);
    const r = await fetch("/api/payments/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product, provider }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok && j.url) { window.location.href = j.url; return; }
    setErr(j.error ?? "Couldn't start checkout. Nothing was charged."); setBusy(null);
  }
  if (!options.length) return null;
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {options.map((o, i) => (
          <Button key={o.provider} variant={i === 0 ? variant : "outline"} className="flex-1" disabled={!!busy} onClick={() => go(o.provider)}>
            {busy === o.provider && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {o.label}
          </Button>
        ))}
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
