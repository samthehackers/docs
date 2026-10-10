"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2 } from "lucide-react";

/** About two minutes of polling (40 tries, 3 s apart) before the page stops waiting and says what to do. */
export const POLL_LIMIT = 40;

/**
 * Polls GET /api/payments/status?reference=. It never grants anything and never trusts its own URL: access is granted only by the
 * verified webhook, and this page just reads the result. If confirmation is late or never comes, it stops spinning and shows the
 * reference with the way forward.
 */
export function PollStatus({ reference }: { reference: string }) {
  const [status, setStatus] = useState<string>("pending");
  const [tries, setTries] = useState(0);
  const router = useRouter();
  const final = status === "success" || ["rejected", "failed", "abandoned", "expired"].includes(status);

  useEffect(() => {
    if (final || tries >= POLL_LIMIT) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/payments/status?reference=${encodeURIComponent(reference)}`).catch(() => null);
      if (r?.ok) setStatus((await r.json()).status);
      setTries((n) => n + 1);
    }, tries === 0 ? 0 : 3000);
    return () => clearTimeout(t);
  }, [final, tries, reference]);

  useEffect(() => { if (status === "success") { const t = setTimeout(() => router.push("/dashboard"), 1500); return () => clearTimeout(t); } }, [status, router]);

  return <PaymentState status={status} timedOut={!final && tries >= POLL_LIMIT} reference={reference} />;
}

/** The page's content for a status. Separate so every state is rendered in tests without timers. */
export function PaymentState({ status, timedOut, reference }: { status: string; timedOut: boolean; reference: string }) {
  const ref = <p className="mt-3 text-sm">Payment reference: <span className="font-mono">{reference}</span></p>;
  const links = (
    <p className="mt-4 flex justify-center gap-4 text-sm">
      <Link href="/billing" className="text-primary underline">Go to Billing</Link>
      <Link href="/support" className="text-primary underline">Contact support</Link>
    </p>
  );
  if (status === "success") return <div role="status" className="text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-green-400" aria-hidden /><h1 className="mt-4 text-2xl font-bold">You're in.</h1><p className="text-muted-foreground">Taking you to your dashboard…</p></div>;
  if (["rejected", "failed", "abandoned", "expired"].includes(status)) {
    return (
      <div role="alert" className="max-w-md text-center">
        <h1 className="text-2xl font-bold">Payment didn't go through</h1>
        <p className="text-muted-foreground">Nothing was unlocked for this payment. If money left your account, contact support with the reference below.</p>
        {ref}{links}
      </div>
    );
  }
  if (timedOut) {
    return (
      <div role="status" className="max-w-md text-center">
        <h1 className="text-2xl font-bold">Still waiting for confirmation</h1>
        <p className="text-muted-foreground">The payment provider hasn't confirmed this payment yet. If you paid, it is applied automatically when the confirmation arrives; you can leave this page. Billing shows its status.</p>
        {ref}{links}
      </div>
    );
  }
  return (
    <div role="status" className="text-center">
      <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" aria-hidden />
      <h1 className="mt-4 text-2xl font-bold">Confirming your payment</h1>
      <p className="text-muted-foreground">This usually takes a few seconds.</p>
    </div>
  );
}
