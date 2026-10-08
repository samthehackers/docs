"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Circle, ImagePlus, Loader2, Save, Square, Play, Aperture } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { connectLucy, readStats, type ConnState, type LucyConnection, type RtcStats } from "@/lib/fal/signaling";
import { BUILTIN_PRESETS, TYPE_BY_KIND, type PresetKind } from "@/lib/studio-presets";
import { readUrl, uploadFile } from "@/lib/client-upload";
import { HEARTBEAT_SECONDS } from "@/lib/plans";
import { cn } from "@/lib/utils";

export interface StudioProps {
  resolution: "low" | "high";
  clipRecording: boolean;
  balance: number;
  presets: { id: number; name: string; kind: PresetKind; prompt: string; imagePath: string | null }[];
  initial: { prompt: string; enablePromptExpansion: boolean; kind: PresetKind; referencePath: string | null };
}

const SIZE = { low: { width: 640, height: 360 }, high: { width: 1280, height: 720 } };
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

export function Studio(p: StudioProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [camError, setCamError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(p.initial.prompt);
  const [expand, setExpand] = useState(p.initial.enablePromptExpansion);
  const [kind, setKind] = useState<PresetKind>(p.initial.kind);
  const [refPath, setRefPath] = useState<string | null>(p.initial.referencePath);
  const [uploading, setUploading] = useState(false);
  const [state, setState] = useState<ConnState>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(p.balance);
  const [sessionLeft, setSessionLeft] = useState<number | null>(null);
  const [stats, setStats] = useState<RtcStats | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");

  const localRef = useRef<HTMLVideoElement>(null);
  const outRef = useRef<HTMLVideoElement>(null);
  const camStream = useRef<MediaStream | null>(null);
  const conn = useRef<LucyConnection | null>(null);
  const sessionId = useRef<string | null>(null);
  const hb = useRef<ReturnType<typeof setInterval> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const statTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStats = useRef<RtcStats | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const live = state === "live" || state === "connecting";

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3500); };

  const startCamera = useCallback(async (id?: string) => {
    camStream.current?.getTracks().forEach((t) => t.stop());
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), ...SIZE[p.resolution], frameRate: { ideal: 30 } }, audio: false });
      camStream.current = s;
      if (localRef.current) localRef.current.srcObject = s;
      setCamError(null);
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      setDevices(all);
      setDeviceId(s.getVideoTracks()[0]?.getSettings().deviceId ?? id ?? "");
    } catch (e) {
      setCamError(e instanceof DOMException && e.name === "NotAllowedError" ? "Camera access was blocked. Allow it in your browser and retry." : "Couldn't open a camera.");
    }
  }, [p.resolution]);

  useEffect(() => { void startCamera(); return () => camStream.current?.getTracks().forEach((t) => t.stop()); }, [startCamera]);

  const clearTimers = () => {
    for (const t of [hb, tick, statTimer]) { if (t.current) clearInterval(t.current); t.current = null; }
  };

  const stop = useCallback(async (reason?: string) => {
    clearTimers();
    if (recorder.current?.state === "recording") recorder.current.stop();
    conn.current?.close();
    conn.current = null;
    if (outRef.current) outRef.current.srcObject = null;
    remoteStream.current = null;
    const id = sessionId.current;
    sessionId.current = null;
    setStats(null);
    setState("idle");
    if (reason) setDetail(reason);
    if (id) {
      const r = await fetch("/api/studio/session/end", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }) }).catch(() => null);
      if (r?.ok) setRemaining((await r.json()).remaining);
    }
  }, []);

  useEffect(() => {
    const onUnload = () => { if (sessionId.current) navigator.sendBeacon("/api/studio/session/end", new Blob([JSON.stringify({ sessionId: sessionId.current })], { type: "application/json" })); };
    window.addEventListener("pagehide", onUnload);
    return () => { window.removeEventListener("pagehide", onUnload); void stop(); };
  }, [stop]);

  async function connect(id: string) {
    let referenceImageUrl: string | undefined;
    if (refPath) referenceImageUrl = await readUrl(refPath);
    conn.current = connectLucy({
      sessionId: id, stream: camStream.current!, inputs: { prompt, enablePromptExpansion: expand, referenceImageUrl },
      onRemoteStream: (s) => { remoteStream.current = s; if (outRef.current) outRef.current.srcObject = s; },
      onState: (s, d) => { setState(s); setDetail(d ?? null); },
    });
  }

  async function goLive() {
    if (!camStream.current) return;
    setDetail(null);
    setState("connecting");
    const res = await fetch("/api/studio/session/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: { prompt, expand, kind } }) });
    if (!res.ok) {
      setState("idle");
      const j = await res.json().catch(() => ({}));
      setDetail(res.status === 402 ? "You're out of credits." : j.error ?? "Couldn't start a session");
      return;
    }
    const s = await res.json();
    sessionId.current = s.sessionId;
    setRemaining(s.remaining);
    setSessionLeft(s.maxSeconds);
    try { await connect(s.sessionId); } catch (e) { await stop(e instanceof Error ? e.message : "Couldn't connect"); return; }

    tick.current = setInterval(() => { setRemaining((r) => Math.max(0, r - 1)); setSessionLeft((x) => (x === null ? x : Math.max(0, x - 1))); }, 1000);
    statTimer.current = setInterval(async () => {
      const pc = conn.current?.pc();
      if (pc) { try { const st = await readStats(pc); lastStats.current = st; setStats(st); } catch { /* ignore */ } }
    }, 2000);
    hb.current = setInterval(async () => {
      const id = sessionId.current; if (!id) return;
      const st = lastStats.current;
      const r = await fetch("/api/studio/session/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id, stats: st ? { fps: st.fps, rttMs: st.rttMs } : undefined }) }).catch(() => null);
      if (!r) return; // transient network error: server will close us if it persists
      if (!r.ok) { await stop("Session ended"); return; }
      const j = await r.json();
      setRemaining(j.remaining); setSessionLeft(j.secondsLeftInSession);
      if (!j.continue) await stop(j.reason === "credits" ? "You're out of credits." : "Session limit reached for your plan.");
    }, HEARTBEAT_SECONDS * 1000);
  }

  /** The model takes its inputs with the offer, so applying new inputs means re-negotiating the stream. */
  async function applyChanges() {
    if (!sessionId.current) return;
    conn.current?.close();
    setState("connecting");
    try { await connect(sessionId.current); } catch (e) { await stop(e instanceof Error ? e.message : "Couldn't reconnect"); }
  }

  async function onRef(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try { setRefPath(await uploadFile("reference", file)); } catch (e) { flash(e instanceof Error ? e.message : "Upload failed"); }
    setUploading(false);
  }

  async function snapshot() {
    const v = outRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = 480; c.height = Math.round((480 * v.videoHeight) / v.videoWidth);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.8));
    if (!blob) return;
    try {
      const path = await uploadFile("thumbnail", blob);
      const res = await fetch("/api/studio/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thumbnailPath: path, title: prompt.slice(0, 60) || "Snapshot", prompt, type: TYPE_BY_KIND[kind], sessionId: sessionId.current ?? undefined, settings: { prompt, expand, kind, referencePath: refPath } }) });
      flash(res.ok ? "Saved to History" : "Couldn't save snapshot");
    } catch { flash("Couldn't save snapshot"); }
  }

  function toggleRecord() {
    if (recording) { recorder.current?.stop(); return; }
    const s = remoteStream.current; if (!s) return;
    const chunks: Blob[] = [];
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
    const rec = new MediaRecorder(s, { mimeType: mime });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      setRecording(false);
      const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      const a = document.createElement("a"); a.href = url; a.download = `altrcam-${Date.now()}.webm`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };
    rec.start(1000); recorder.current = rec; setRecording(true);
  }

  async function savePreset() {
    const name = presetName.trim(); if (!name) return;
    const res = await fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, kind, prompt, imagePath: refPath, settings: { expand } }) });
    const j = await res.json().catch(() => ({}));
    flash(res.ok ? "Preset saved" : j.error ?? "Couldn't save preset");
    if (res.ok) setPresetName("");
  }

  const pick = (pr: { kind: PresetKind; prompt: string; imagePath?: string | null }) => { setKind(pr.kind); setPrompt(pr.prompt); if (pr.imagePath !== undefined) setRefPath(pr.imagePath); };
  const low = remaining <= 30;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs", state === "live" ? "border-green-500/50 text-green-400" : state === "failed" ? "border-destructive/50 text-destructive" : "text-muted-foreground")} role="status">
            <span className={cn("h-2 w-2 rounded-full", state === "live" ? "bg-green-400" : state === "connecting" ? "animate-pulse bg-yellow-400" : "bg-muted-foreground")} />
            {state === "idle" ? "Ready" : state === "connecting" ? "Connecting" : state === "live" ? "Live" : state === "failed" ? "Failed" : "Closed"}
          </span>
          {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
        </div>
        <div className="text-right" aria-live="polite">
          <p className={cn("text-2xl font-bold tabular-nums", low && "text-accent")}>{remaining.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">credits</span></p>
          {live && sessionLeft !== null && <p className="text-xs text-muted-foreground">Session ends in {fmt(Math.min(sessionLeft, remaining))}</p>}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <figure className="overflow-hidden rounded-lg border bg-black">
          <video ref={localRef} autoPlay muted playsInline className="aspect-video w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
          <figcaption className="px-3 py-2 text-xs text-muted-foreground">You</figcaption>
        </figure>
        <figure className="relative overflow-hidden rounded-lg border bg-black">
          <video ref={outRef} autoPlay playsInline className="aspect-video w-full object-cover" aria-label="AI transformed output" />
          {state !== "live" && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{state === "connecting" ? <Loader2 className="h-6 w-6 animate-spin" aria-label="Connecting" /> : "Your transformation appears here"}</div>}
          <figcaption className="px-3 py-2 text-xs text-muted-foreground">AltrCam</figcaption>
        </figure>
      </div>
      {camError && <p role="alert" className="text-sm text-destructive">{camError}</p>}

      {stats && (
        <dl className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3 text-xs sm:grid-cols-4" aria-label="Connection diagnostics">
          {[["FPS", stats.fps], ["RTT", `${stats.rttMs} ms`], ["Jitter", `${stats.jitterMs} ms`], ["Packet loss", `${stats.lossPct}%`]].map(([k, v]) => (
            <div key={k as string}><dt className="text-muted-foreground">{k}</dt><dd className="text-base font-semibold tabular-nums">{v}</dd></div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        {!live ? (
          <Button variant="gradient" size="lg" onClick={goLive} disabled={!camStream.current || p.balance <= 0 && remaining <= 0}><Play className="h-4 w-4" aria-hidden /> Go live</Button>
        ) : (
          <Button variant="destructive" size="lg" onClick={() => stop()}><Square className="h-4 w-4" aria-hidden /> Stop</Button>
        )}
        {live && <Button variant="outline" size="lg" onClick={applyChanges} disabled={state !== "live"}>Apply changes</Button>}
        <Button variant="outline" size="lg" onClick={snapshot} disabled={state !== "live"}><Aperture className="h-4 w-4" aria-hidden /> Snapshot</Button>
        {p.clipRecording ? (
          <Button variant="outline" size="lg" onClick={toggleRecord} disabled={state !== "live"}><Circle className={cn("h-4 w-4", recording && "fill-destructive text-destructive")} aria-hidden /> {recording ? "Stop & download" : "Record clip"}</Button>
        ) : (
          <Link href="/billing" className={buttonClass({ variant: "ghost", size: "lg" })}>Clips need Pro</Link>
        )}
        {remaining <= 0 && <Link href="/billing" className={buttonClass({ variant: "gradient", size: "lg" })}>Top up credits</Link>}
      </div>

      <div className="grid gap-6 rounded-lg border bg-card p-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">Presets</p>
            <div className="flex flex-wrap gap-2">
              {BUILTIN_PRESETS.map((b) => <Button key={b.id} variant="outline" size="sm" onClick={() => pick(b)}>{b.name}</Button>)}
              {p.presets.map((u) => <Button key={u.id} variant="ghost" size="sm" className="border" onClick={() => pick(u)}>{u.name}</Button>)}
            </div>
          </div>
          <div>
            <label htmlFor="prompt" className="mb-2 block text-sm font-medium">Prompt</label>
            <Textarea id="prompt" value={prompt} maxLength={1000} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe who or what you want to become" />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" /> Expand my prompt automatically</label>
          <div className="flex flex-wrap items-center gap-2">
            <label className={cn(buttonClass({ variant: "outline", size: "sm" }), "cursor-pointer")}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" aria-hidden />} Reference image
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => void onRef(e.target.files?.[0])} />
            </label>
            {refPath && <><span className="text-xs text-muted-foreground">Attached</span><Button variant="ghost" size="sm" onClick={() => setRefPath(null)}>Remove</Button></>}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <label htmlFor="cam" className="mb-2 flex items-center gap-2 text-sm font-medium"><Camera className="h-4 w-4" aria-hidden /> Camera</label>
            <Select id="cam" value={deviceId} disabled={live} onChange={(e) => { setDeviceId(e.target.value); void startCamera(e.target.value); }}>
              {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="pname" className="mb-2 block text-sm font-medium">Save as preset</label>
            <div className="flex gap-2">
              <Input id="pname" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Name" maxLength={60} />
              <Button variant="outline" size="icon" onClick={savePreset} aria-label="Save preset" disabled={!presetName.trim()}><Save className="h-4 w-4" /></Button>
            </div>
          </div>
        </div>
      </div>
      {toast && <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md border bg-card px-4 py-2 text-sm shadow-xl">{toast}</div>}
    </div>
  );
}
