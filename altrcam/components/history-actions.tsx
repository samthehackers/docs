"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { Button, buttonClass } from "@/components/ui/button";

export function HistoryActions({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!confirm("Delete this transformation?")) return;
    setBusy(true);
    const r = await fetch(`/api/history/${id}`, { method: "DELETE" });
    setBusy(false);
    if (r.ok) router.refresh();
  }
  return (
    <div className="flex gap-2">
      <Link href={`/studio?reuse=${id}`} className={buttonClass({ variant: "outline", size: "sm" })}>Reuse settings</Link>
      <Button variant="ghost" size="sm" onClick={del} disabled={busy}>Delete</Button>
    </div>
  );
}
