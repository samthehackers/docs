"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Camera, Circle, ImagePlus, Loader2, RotateCcw, Save, Square, Play, Aperture, WifiOff } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { connectLucy, readStats } from "@/lib/fal/signaling";
import { BUILTIN_PRESETS, TYPE_BY_KIND, type PresetKind } from "@/lib/studio-presets";
import { readUrl, uploadFile } from "@/lib/client-upload";
import { HEARTBEAT_SECONDS } from "@/lib/plans";
import { createCamera, EMPTY_CAMERA_VIEW, type Camera as CameraController, type CameraView } from "@/lib/studio-camera";
import { browserNetwork, createStudioSession, initialSessionView, type SessionView, type StartInputs, type StudioSession } from "@/lib/studio-session";
import { MESSAGES, STUDIO_NOTICES } from "@/lib/studio-messages";
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

/**
 * The Studio page. The camera (lib/studio-camera.ts) and the live session (lib/studio-session.ts) are plain objects
 * that own their timers, listeners and connections and are unit-tested; this component only shows their state and
 * forwards clicks. Both are created on mount and disposed on unmount.
 */
export function Studio(p: StudioProps) {
  const [cam, setCam] = useState<CameraView>(EMPTY_CAMERA_VIEW);
  const [sess, setSess] = useState<SessionView>(() => initialSessionView(p.balance));
  const [prompt, setPrompt] = useState(p.initial.prompt);
  const [expand, setExpand] = useState(p.initial.enablePromptExpansion);
  const [kind, setKind] = useState<PresetKind>(p.initial.kind);
  const [refPath, setRefPath] = useState<string | null>(p.initial.referencePath);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");

  const localRef = useRef<HTMLVideoElement>(null);
  const outRef = useRef<HTMLVideoElement>(null);
  const camera = useRef<CameraController | null>(null);
  const session = useRef<StudioSession | null>(null);
  const remoteStream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startBalance = useRef(p.balance);
  const mounted = useRef(true);

  const live = sess.state === "live" || sess.state === "connecting";
  const failed = sess.state === "failed";
  const inputs = (): StartInputs => ({ prompt, expand, kind, referencePath: refPath });

  const flash = (m: string) => {
    if (!mounted.current) return; // an upload or snapshot that finishes after leaving the page must not start a timer
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(m);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);

  useEffect(() => {
    const c = createCamera({
      mediaDevices: navigator.mediaDevices,
      secureContext: window.isSecureContext,
      size: SIZE[p.resolution],
      attach: (s) => { if (localRef.current) localRef.current.srcObject = s; },
      onLost: () => { void session.current?.cameraLost(); },
    });
    camera.current = c;
    const off = c.subscribe(setCam);
    void c.start();
    return () => { off(); c.dispose(); camera.current = null; };
  }, [p.resolution]);

  useEffect(() => {
    const s = createStudioSession({
      fetch: (url, init) => fetch(url, init),
      connect: connectLucy,
      readStats,
      referenceUrl: readUrl,
      getStream: () => (camera.current?.hasLiveVideo() ? camera.current.stream() : null),
      onRemoteStream: (st) => {
        remoteStream.current = st;
        if (!st && recorder.current?.state === "recording") recorder.current.stop();
        if (outRef.current) outRef.current.srcObject = st;
      },
      network: browserNetwork(),
      balance: startBalance.current, // only the starting balance: the session keeps its own count from here
      heartbeatSeconds: HEARTBEAT_SECONDS,
    });
    session.current = s;
    const off = s.subscribe(setSess);
    setSess(s.view()); // picks up whether the browser starts out offline
    const onUnload = () => { const id = s.sessionId(); if (id) navigator.sendBeacon("/api/studio/session/end", new Blob([JSON.stringify({ sessionId: id })], { type: "application/json" })); };
    window.addEventListener("pagehide", onUnload);
    return () => { window.removeEventListener("pagehide", onUnload); off(); s.dispose(); session.current = null; };
  }, []);

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
      const res = await fetch("/api/studio/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ thumbnailPath: path, title: prompt.slice(0, 60) || "Snapshot", prompt, type: TYPE_BY_KIND[kind], sessionId: session.current?.sessionId() ?? undefined, settings: { prompt, expand, kind, referencePath: refPath } }) });
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
  const low = sess.remaining <= 30;
  const retryLabel = sess.notice?.retryLabel;
  // Retry camera helps with every camera problem except a page or browser that can't use cameras at all.
  const canRetryCamera = cam.problem && cam.problem.code !== "insecure" && cam.problem.code !== "unsupported";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs", sess.state === "live" ? "border-green-500/50 text-green-400" : failed ? "border-destructive/50 text-destructive" : "text-muted-foreground")} role="status">
            <span className={cn("h-2 w-2 rounded-full", sess.state === "live" ? "bg-green-400" : sess.state === "connecting" ? "animate-pulse bg-yellow-400" : failed ? "bg-destructive" : "bg-muted-foreground")} />
            {sess.state === "idle" ? "Ready" : sess.state === "connecting" ? "Connecting" : sess.state === "live" ? "Live" : failed ? "Failed" : "Closed"}
          </span>
        </div>
        <div className="text-right" aria-live="polite">
          <p className={cn("text-2xl font-bold tabular-nums", low && "text-accent")}>{sess.remaining.toLocaleString()} <span className="text-sm font-normal text-muted-foreground">credits</span></p>
          {live && sess.sessionLeft !== null && <p className="text-xs text-muted-foreground">Session ends in {fmt(Math.min(sess.sessionLeft, sess.remaining))}</p>}
        </div>
      </div>

      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">{STUDIO_NOTICES.unverified}</p>

      {sess.offline && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-yellow-500/40 p-3 text-sm text-yellow-400"><WifiOff className="h-4 w-4 shrink-0" aria-hidden /> {live ? MESSAGES.offlineLive : MESSAGES.offlineIdle}</p>
      )}
      {sess.notice && (
        <div role={sess.notice.tone === "error" ? "alert" : "status"} className={cn("rounded-lg border p-3 text-sm", sess.notice.tone === "error" ? "border-destructive/50 text-destructive" : "text-muted-foreground")}>
          <p>{sess.notice.text}</p>
          {sess.notice.hint && <p className="mt-1 text-xs text-muted-foreground">{sess.notice.hint}</p>}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <figure className="overflow-hidden rounded-lg border bg-black">
          <video ref={localRef} autoPlay muted playsInline className="aspect-video w-full -scale-x-100 object-cover" aria-label="Your camera preview" />
          <figcaption className="px-3 py-2 text-xs text-muted-foreground">You</figcaption>
        </figure>
        <figure className="relative overflow-hidden rounded-lg border bg-black">
          <video ref={outRef} autoPlay playsInline className="aspect-video w-full object-cover" aria-label="AI transformed output" />
          {sess.state !== "live" && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{sess.state === "connecting" ? <Loader2 className="h-6 w-6 animate-spin" aria-label="Connecting" /> : failed ? "Not connected" : "Your transformation appears here"}</div>}
          <figcaption className="px-3 py-2 text-xs text-muted-foreground">AltrCam</figcaption>
        </figure>
      </div>
      <p className="text-xs text-muted-foreground">{STUDIO_NOTICES.videoOnly}</p>
      {cam.problem && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/50 p-3 text-sm text-destructive">
          <p className="min-w-0 flex-1">{cam.problem.message}</p>
          {canRetryCamera && <Button variant="outline" size="sm" onClick={() => void camera.current?.retry()} disabled={cam.busy}><RotateCcw className="h-4 w-4" aria-hidden /> Retry camera</Button>}
        </div>
      )}

      {sess.stats && (
        <dl className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-3 text-xs sm:grid-cols-4" aria-label="Connection diagnostics">
          {[["FPS", sess.stats.fps], ["RTT", `${sess.stats.rttMs} ms`], ["Jitter", `${sess.stats.jitterMs} ms`], ["Packet loss", `${sess.stats.lossPct}%`]].map(([k, v]) => (
            <div key={k as string}><dt className="text-muted-foreground">{k}</dt><dd className="text-base font-semibold tabular-nums">{v}</dd></div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap gap-2">
        {!live ? (
          <Button variant="gradient" size="lg" onClick={() => void (retryLabel ? session.current?.reconnect(inputs()) : session.current?.start(inputs()))} disabled={!cam.ready || p.balance <= 0 && sess.remaining <= 0}>
            {retryLabel ? <RotateCcw className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} {retryLabel ?? "Go live"}
          </Button>
        ) : (
          <Button variant="destructive" size="lg" onClick={() => void session.current?.stop()}><Square className="h-4 w-4" aria-hidden /> Stop</Button>
        )}
        {sess.state === "connecting" && <Button variant="outline" size="lg" onClick={() => void session.current?.reconnect(inputs())}><RotateCcw className="h-4 w-4" aria-hidden /> Reconnect</Button>}
        {live && <Button variant="outline" size="lg" onClick={() => void session.current?.applyChanges(inputs())} disabled={sess.state !== "live"}>Apply changes</Button>}
        <Button variant="outline" size="lg" onClick={snapshot} disabled={sess.state !== "live"}><Aperture className="h-4 w-4" aria-hidden /> Snapshot</Button>
        {p.clipRecording ? (
          <Button variant="outline" size="lg" onClick={toggleRecord} disabled={sess.state !== "live"}><Circle className={cn("h-4 w-4", recording && "fill-destructive text-destructive")} aria-hidden /> {recording ? "Stop & download" : "Record clip"}</Button>
        ) : (
          <Link href="/billing" className={buttonClass({ variant: "ghost", size: "lg" })}>Clips need Pro</Link>
        )}
        {sess.remaining <= 0 && <Link href="/billing" className={buttonClass({ variant: "gradient", size: "lg" })}>Top up credits</Link>}
      </div>
      {sess.state === "connecting" && <p className="text-xs text-muted-foreground">{MESSAGES.reconnectHint}</p>}

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
            <Select id="cam" value={cam.deviceId} disabled={live || cam.busy} onChange={(e) => void camera.current?.start(e.target.value)}>
              {cam.devices.length === 0 && <option value="">{cam.busy ? "Opening camera…" : "No camera available"}</option>}
              {cam.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
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
