"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { ImagePlus, Trash2 } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select, Textarea } from "@/components/ui/input";
import { uploadFile } from "@/lib/client-upload";

interface P { id: number; name: string; kind: string; prompt: string; hasImage: boolean }

export function PresetsManager({ presets, cap }: { presets: P[]; cap: number }) {
  const router = useRouter();
  const [name, setName] = useState(""); const [kind, setKind] = useState("prompt"); const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const r = await fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, kind, prompt, imagePath: image }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(j.error ?? "Couldn't save");
    setName(""); setPrompt(""); setImage(null); router.refresh();
  }
  async function onImage(f?: File) {
    if (!f) return;
    try { setImage(await uploadFile(kind === "outfit" ? "outfit" : kind === "background" ? "background" : "reference", f)); } catch (e) { setErr(e instanceof Error ? e.message : "Upload failed"); }
  }
  async function del(id: number) {
    if (!confirm("Delete this preset?")) return;
    const r = await fetch(`/api/presets/${id}`, { method: "DELETE" });
    if (r.ok) router.refresh();
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[360px_1fr]">
      <Card>
        <h2 className="mb-4 font-semibold">New preset <span className="text-xs font-normal text-muted-foreground">({presets.length}/{cap})</span></h2>
        <form onSubmit={create} className="space-y-3">
          <label className="block text-sm">Name<Input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className="mt-1" /></label>
          <label className="block text-sm">Type<Select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1"><option value="prompt">Prompt</option><option value="background">Background</option><option value="outfit">Outfit</option><option value="style">Style</option></Select></label>
          <label className="block text-sm">Prompt<Textarea value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} className="mt-1" /></label>
          <label className={buttonClass({ variant: "outline", size: "sm", className: "cursor-pointer" })}><ImagePlus className="h-4 w-4" aria-hidden /> {image ? "Image attached" : "Add image"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void onImage(e.target.files?.[0])} /></label>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <Button type="submit" variant="gradient" className="w-full" disabled={busy || presets.length >= cap}>{presets.length >= cap ? "Preset limit reached" : "Save preset"}</Button>
        </form>
      </Card>
      <div>
        {presets.length === 0 ? <Card className="py-12 text-center text-muted-foreground">No presets yet. Save one here or from the studio.</Card> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {presets.map((p) => (
              <li key={p.id}><Card className="space-y-2">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{p.kind}{p.hasImage ? " · image" : ""}</p></div>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${p.name}`} onClick={() => del(p.id)}><Trash2 className="h-4 w-4" /></Button></div>
                <p className="line-clamp-3 text-sm text-muted-foreground">{p.prompt || "No prompt"}</p>
                <Link href={`/studio?preset=${p.id}`} className={buttonClass({ variant: "outline", size: "sm" })}>Use in studio</Link>
              </Card></li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
