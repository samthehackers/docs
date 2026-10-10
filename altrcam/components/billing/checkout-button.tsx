"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
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

/** Cancel at period end. Refreshes the page when done; a second click (or another tab) reads "Already cancelled", not an error. */
export function CancelButton({ endsLabel }: { endsLabel?: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  async function cancel() {
    if (!confirm(`Cancel your subscription? Pro stays active until ${endsLabel ?? "the end of the paid period"} and you won't be charged again.`)) return;
    setBusy(true); setMsg(null);
    const r = await fetch("/api/payments/cancel", { method: "POST" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setDone(true); setMsg({ text: j.message ?? "Cancelled." }); router.refresh(); }
    else if (r?.status === 404) { setDone(true); setMsg({ text: "Already cancelled. Pro stays active until the end of the period you paid for." }); router.refresh(); }
    else setMsg({ text: j.error ?? "Couldn't cancel. Nothing changed; try again or contact support.", error: true });
    setBusy(false);
  }
  return (
    <div>
      {!done && <Button variant="outline" size="sm" onClick={cancel} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Cancel subscription</Button>}
      {msg && <p role={msg.error ? "alert" : "status"} className={`mt-2 text-xs ${msg.error ? "text-destructive" : "text-muted-foreground"}`}>{msg.text}</p>}
    </div>
  );
}
