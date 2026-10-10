"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connectLucy } from "@/lib/fal/signaling";
import { DIAG_DOM, PASS_CRITERIA, type DiagnosticsReport } from "@/lib/diagnostics/criteria";
import { DEFAULT_DIAG_PROMPT, DIAG_END_URL, runDiagnostics } from "@/lib/diagnostics/run";
import { startSyntheticCamera, SYNTHETIC_CAMERA } from "@/lib/diagnostics/synthetic-camera";

const fmtMs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);
const fmtNum = (n: number | null | undefined, unit = "") => (n === null || n === undefined ? "—" : `${n}${unit}`);
const yes = (b: boolean | null | undefined) => (b === null || b === undefined ? "—" : b ? "yes" : "NO");

/** Runs the realtime check in this tab (see lib/diagnostics/run.ts) and shows the report. */
export function DiagnosticsPanel({ app, configured }: { app: string; configured: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const outRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_DIAG_PROMPT);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Leaving the page mid-check: stop it, and end the server session even if the page's own cleanup cannot finish.
  useEffect(() => {
    const onHide = () => {
      abortRef.current?.abort();
      if (sessionRef.current) navigator.sendBeacon?.(DIAG_END_URL, JSON.stringify({ sessionId: sessionRef.current }));
    };
    window.addEventListener("pagehide", onHide);
    return () => { window.removeEventListener("pagehide", onHide); abortRef.current?.abort(); };
  }, []);

  async function run() {
    if (running || !canvasRef.current || !outRef.current) return;
    const canvas = canvasRef.current, output = outRef.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true); setCopied(null); setReport(null);
    try {
      const final = await runDiagnostics({
        fetch: (u, i) => fetch(u, i), connect: connectLucy, camera: () => startSyntheticCamera(canvas), output,
        endpoint: window.location.origin, app, prompt: prompt.trim() || DEFAULT_DIAG_PROMPT,
        // Once the runner is ending the session itself (a keepalive request), the pagehide beacon would only duplicate it.
        onProgress: (r) => { sessionRef.current = r.steps.some((s) => s.name === "ending_session") ? null : r.sessionId; setReport({ ...r, steps: [...r.steps] }); },
      }, ac.signal);
      sessionRef.current = null;
      setReport({ ...final });
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  const json = report ? JSON.stringify(report, null, 2) : "";
  async function copy() {
    try { await navigator.clipboard.writeText(json); setCopied("Copied"); }
    catch { setCopied("Couldn't use the clipboard: select the JSON below and copy it"); }
  }

  const m = report?.metrics;
  const done = report && report.status !== "running";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground">Prompt sent with the check
          <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={running} maxLength={500} className="mt-1" />
        </label>
        {running
          ? <Button variant="outline" onClick={() => abortRef.current?.abort()} data-testid={DIAG_DOM.stop}>Stop</Button>
          : <Button onClick={run} data-testid={DIAG_DOM.run}>{report ? "Run again" : "Run check"}</Button>}
      </div>
      {!configured && <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm">The fal API key is not set on this deployment, so the server will refuse the check (it will report <code>not_configured</code>).</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <figure className="space-y-1">
          <canvas ref={canvasRef} width={SYNTHETIC_CAMERA.width} height={SYNTHETIC_CAMERA.height} className="aspect-video w-full rounded-md border bg-black" aria-label="Synthetic camera sent to the model" />
          <figcaption className="text-xs text-muted-foreground">Sent: synthetic camera ({SYNTHETIC_CAMERA.width}×{SYNTHETIC_CAMERA.height}, {SYNTHETIC_CAMERA.fps} fps canvas)</figcaption>
        </figure>
        <figure className="space-y-1">
          <video ref={outRef} autoPlay muted playsInline className="aspect-video w-full rounded-md border bg-black" aria-label="Video received from the model" />
          <figcaption className="text-xs text-muted-foreground">Received: video from the model</figcaption>
        </figure>
      </div>

      {report && (
        <section data-testid={DIAG_DOM.result} data-status={report.status} aria-live="polite" className="space-y-4">
          <p className={`rounded-md border p-3 font-semibold ${report.status === "pass" ? "border-green-600 text-green-600" : report.status === "fail" ? "border-destructive text-destructive" : ""}`}>
            {report.status === "running" ? "Running…" : report.verdict}
          </p>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm"><tbody className="divide-y">
              {([
                ["Endpoint", report.endpoint],
                ["App", report.app],
                ["Time to first frame", `${fmtMs(m?.timeToFirstFrameMs)} (limit ${fmtMs(PASS_CRITERIA.firstFrameMaxMs)})`],
                ["Resolution", m?.resolution ? `${m.resolution.width}×${m.resolution.height}` : "—"],
                ["FPS (decoded, average)", `${fmtNum(m?.fps)} (need ≥ ${PASS_CRITERIA.minFps})`],
                ["FPS (slowest interval)", `${fmtNum(m?.minIntervalFps)} (need ≥ ${PASS_CRITERIA.minIntervalFps})`],
                ["FPS (displayed)", fmtNum(m?.displayedFps)],
                ["RTT avg / max", m?.rttMs ? `${m.rttMs.avg} / ${m.rttMs.max} ms` : "—"],
                ["Jitter avg / max", m?.jitterMs ? `${m.jitterMs.avg} / ${m.jitterMs.max} ms` : "—"],
                ["Packet loss", fmtNum(m?.packetLossPct, " %")],
                ["Sample window", done ? fmtMs(m?.sampleMs) : "—"],
                ["Failure", report.failure ? `${report.failure.code}${report.failure.status ? ` (HTTP/close ${report.failure.status})` : ""}: ${report.failure.message}` : "none"],
                ["Server messages", report.serverMessages.length ? report.serverMessages.slice(0, 12).join(", ") + (report.serverMessages.length > 12 ? ", …" : "") : "none"],
                ["ICE candidates (local / remote)", `${report.counts.localCandidates} / ${report.counts.remoteCandidates}`],
                ["Cleanup", done ? `tracks stopped ${yes(report.cleanup.tracksStopped)}, peer closed ${yes(report.cleanup.peerClosed)}, connection closed ${yes(report.cleanup.connectionClosed)}, session ended ${yes(report.cleanup.sessionEnded)}` : "—"],
                ["Session", report.sessionId ?? "—"],
              ] as const).map(([k, v]) => <tr key={k}><th scope="row" className="w-56 p-3 font-medium text-muted-foreground">{k}</th><td className="p-3 break-all">{v}</td></tr>)}
            </tbody></table>
          </div>

          <h2 className="font-semibold">Steps</h2>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="p-3">+ms</th><th className="p-3">Step</th><th className="p-3">Detail</th><th className="p-3">Time (UTC)</th></tr></thead>
              <tbody className="divide-y">{report.steps.map((s, i) => <tr key={i}><td className="p-3 font-mono text-xs">{s.atMs}</td><td className="p-3">{s.name}</td><td className="p-3 break-all text-xs">{s.detail ?? ""}</td><td className="p-3 font-mono text-xs">{s.at.slice(11, 23)}</td></tr>)}</tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={copy} disabled={!done} data-testid={DIAG_DOM.copy}>Copy as JSON</Button>
            {copied && <span role="status" className="text-xs">{copied}</span>}
          </div>
          <details open={!!done}>
            <summary className="cursor-pointer text-sm text-muted-foreground">Report JSON</summary>
            <pre data-testid={DIAG_DOM.json} className="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{json}</pre>
          </details>
        </section>
      )}
    </div>
  );
}
