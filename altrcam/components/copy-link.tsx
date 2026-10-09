"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* clipboard blocked: the link is selectable */ }
  }
  return (
    <div className="flex gap-2">
      <input readOnly value={url} aria-label="Your referral link" onFocus={(e) => e.currentTarget.select()} className="h-10 w-full rounded-md border bg-muted/40 px-3 text-sm" />
      <Button variant="outline" onClick={copy} aria-label="Copy referral link">{done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{done ? "Copied" : "Copy"}</Button>
    </div>
  );
}
