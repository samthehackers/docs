"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2 } from "lucide-react";

/** Polls payment status. It never grants anything; the verified webhook does. */
export function PollStatus({ reference }: { reference: string }) {
  const [status, setStatus] = useState<string>("pending");
  const [tries, setTries] = useState(0);
  const router = useRouter();

  useEffect(() => {
    if (status === "success" || tries > 40) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/payments/status?reference=${encodeURIComponent(reference)}`).catch(() => null);
      if (r?.ok) setStatus((await r.json()).status);
      setTries((n) => n + 1);
    }, tries === 0 ? 0 : 3000);
    return () => clearTimeout(t);
  }, [status, tries, reference]);

  useEffect(() => { if (status === "success") { const t = setTimeout(() => router.push("/dashboard"), 1500); return () => clearTimeout(t); } }, [status, router]);

  if (status === "success") return <div role="status" className="text-center"><CheckCircle2 className="mx-auto h-12 w-12 text-green-400" /><h1 className="mt-4 text-2xl font-bold">You're in.</h1><p className="text-muted-foreground">Taking you to your dashboard…</p></div>;
  if (status === "rejected" || status === "failed") return <div role="alert" className="text-center"><h1 className="text-2xl font-bold">Payment didn't go through</h1><p className="text-muted-foreground">You haven't been charged for access. Contact support if money left your account.</p></div>;
  return (
    <div role="status" className="text-center">
      <Loader2 className="mx-auto h-10 w-10 animate-spin text-primary" aria-hidden />
      <h1 className="mt-4 text-2xl font-bold">Confirming your payment</h1>
      <p className="text-muted-foreground">{tries > 40 ? "This is taking longer than usual. It will apply automatically once confirmed." : "This usually takes a few seconds."}</p>
    </div>
  );
}
