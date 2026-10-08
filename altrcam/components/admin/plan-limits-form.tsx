"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

export interface Limits {
  monthlyCredits: number; maxSessionSeconds: number; maxResolution: "low" | "high"; presets: number; historyDays: number | null; clipRecording: boolean;
}

export function PlanLimitsForm({ plan, label, value, customised }: { plan: string; label: string; value: Limits; customised: boolean }) {
  const router = useRouter();
  const [v, setV] = useState({ ...value, historyDays: value.historyDays === null ? "" : String(value.historyDays) });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const num = (k: "monthlyCredits" | "maxSessionSeconds" | "presets") => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) });

  async function call(method: "PUT" | "DELETE", body: unknown) {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/admin/plan-limits", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg(j.issues ? "Check the values: " + j.issues.map((i: { path: string[]; message: string }) => `${i.path.join(".")} ${i.message}`).join("; ") : j.error ?? "Failed");
    setMsg(method === "PUT" ? "Saved" : "Reset to defaults");
    router.refresh();
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void call("PUT", { plan, limits: { ...v, historyDays: v.historyDays === "" ? null : Number(v.historyDays) } });
  };
  const field = "text-xs text-muted-foreground";
  return (
    <form onSubmit={save} className="space-y-3">
      <div className="flex items-center justify-between"><h3 className="font-semibold">{label}</h3><span className="text-xs text-muted-foreground">{customised ? "customised" : "defaults"}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className={field}>Monthly credits<Input type="number" min={0} max={1000000} value={v.monthlyCredits} onChange={num("monthlyCredits")} className="mt-1" /></label>
        <label className={field}>Max session (seconds)<Input type="number" min={10} max={14400} value={v.maxSessionSeconds} onChange={num("maxSessionSeconds")} className="mt-1" /></label>
        <label className={field}>Camera resolution<Select value={v.maxResolution} onChange={(e) => setV({ ...v, maxResolution: e.target.value as "low" | "high" })} className="mt-1"><option value="low">Standard (640×360)</option><option value="high">High (1280×720)</option></Select></label>
        <label className={field}>Saved presets<Input type="number" min={0} max={1000} value={v.presets} onChange={num("presets")} className="mt-1" /></label>
        <label className={field}>History days (blank = forever)<Input type="number" min={1} max={3650} value={v.historyDays} onChange={(e) => setV({ ...v, historyDays: e.target.value })} className="mt-1" /></label>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={v.clipRecording} onChange={(e) => setV({ ...v, clipRecording: e.target.checked })} className="h-4 w-4 accent-[hsl(var(--primary))]" /> Clip recording</label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>Save {label}</Button>
        {customised && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { if (confirm(`Reset ${label} to the defaults in code?`)) void call("DELETE", { plan }); }}>Reset to defaults</Button>}
        {msg && <span role="status" className="text-xs">{msg}</span>}
      </div>
    </form>
  );
}
