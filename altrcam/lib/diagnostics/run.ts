/**
 * Browser-only. One realtime check, as run by /admin/diagnostics and driven headless by scripts/smoke-realtime.ts.
 *
 *   synthetic camera → admin diagnostics session (bills nothing) → connectLucy (token through /api/fal/proxy, offer,
 *   answer, ICE) → first transformed frame → getStats() sampled for PASS_CRITERIA.sampleMs → close everything.
 *
 * It uses the Studio's own connection code (connectLucy) unchanged, observed through its optional `onTrace` hook, so a
 * pass here means the same code path can work for users. It never retries. Everything it touches is released on every
 * exit path: the connection (peer + socket), the camera tracks, the remote tracks and the server session.
 * Dependencies are passed in so the flow is unit-tested with fakes (tests/unit/diagnostics-run.test.ts) and the
 * measuring half against a real Chromium WebRTC loopback (tests/public/diagnostics.spec.ts).
 */
import type { ConnectOptions, ConnState, LucyConnection, LucyFailure, TraceEvent } from "@/lib/fal/signaling";
import { emptyMetrics, evaluate, FIRST_FRAME_WAIT_MS, PASS_CRITERIA, redact, STATS_INTERVAL_MS, type DiagFailure, type DiagnosticsReport, type DiagMetrics } from "./criteria";
import { readSample, summarize } from "./measure";

export const DIAG_SESSION_URL = "/api/admin/diagnostics/session";
export const DIAG_END_URL = "/api/admin/diagnostics/session/end";
export const DEFAULT_DIAG_PROMPT = "an oil painting of a person, thick brush strokes";

const POLL_MS = 100;
const MAX_STEPS = 200;
const MAX_SERVER_MESSAGES = 50;
const JSON_HEADERS = { "Content-Type": "application/json" };

export interface Camera { stream: MediaStream; stop: () => void }

export interface RunOptions {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  connect: (o: ConnectOptions) => LucyConnection;
  /** Starts the synthetic camera. */
  camera: () => Camera;
  /** Where the transformed video plays. */
  output: HTMLVideoElement;
  endpoint: string;
  app: string;
  prompt: string;
  /** Called with the (same, mutated) report whenever it changes. */
  onProgress?: (r: DiagnosticsReport) => void;
  now?: () => number;
  wallClock?: () => Date;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export async function runDiagnostics(o: RunOptions, signal?: AbortSignal): Promise<DiagnosticsReport> {
  const now = o.now ?? (() => performance.now());
  const wall = o.wallClock ?? (() => new Date());
  const t0 = now();
  const r: DiagnosticsReport = {
    tool: "altrcam-realtime-diagnostics", version: 1, status: "running", verdict: "Running",
    startedAt: wall().toISOString(), finishedAt: null, durationMs: null,
    endpoint: o.endpoint, app: o.app, prompt: o.prompt, criteria: PASS_CRITERIA,
    sessionId: null, steps: [], serverMessages: [], counts: { localCandidates: 0, remoteCandidates: 0, serverMessages: 0 },
    metrics: emptyMetrics(), samples: [], failure: null,
    cleanup: { tracksStopped: null, peerClosed: null, connectionClosed: false, sessionEnded: null },
  };
  const since = () => Math.round(now() - t0);
  const emit = () => { try { o.onProgress?.(r); } catch { /* the UI cannot break the check */ } };
  const step = (name: string, detail?: string) => {
    if (r.steps.length >= MAX_STEPS) return;
    r.steps.push({ name, atMs: since(), at: wall().toISOString(), ...(detail ? { detail: redact(detail).slice(0, 300) } : {}) });
    emit();
  };
  const fail = (f: DiagFailure) => {
    if (r.failure) return; // the first failure is the cause; later ones are consequences
    r.failure = { code: f.code, message: redact(f.message).slice(0, 500), ...(f.status !== undefined ? { status: f.status } : {}) };
    step("failed", r.failure.code);
  };

  let cam: Camera | null = null;
  let conn: LucyConnection | null = null;
  let pc: RTCPeerConnection | null = null;
  let remote: MediaStream | null = null;
  let connectAt: number | null = null;
  let firstFrameAt: number | null = null;
  let presented = 0;
  let counting = false; // requestVideoFrameCallback is available and counting presented frames
  let finished = false;
  const observers = new AbortController();
  const onAbort = () => fail({ code: "aborted", message: "The check was stopped before it finished" });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const firstFrame = (source: NonNullable<DiagMetrics["firstFrameSource"]>, size?: { width?: number; height?: number }) => {
    if (firstFrameAt !== null || connectAt === null || finished) return;
    firstFrameAt = now();
    r.metrics.firstFrameSource = source;
    r.metrics.timeToFirstFrameMs = Math.round(firstFrameAt - connectAt);
    const w = size?.width ?? o.output.videoWidth, h = size?.height ?? o.output.videoHeight;
    step("first_frame", w && h ? `${w}x${h}` : undefined);
  };
  const onFrame = (_t: number, meta?: { width?: number; height?: number }) => {
    if (finished) return;
    presented++;
    firstFrame("requestVideoFrameCallback", meta);
    o.output.requestVideoFrameCallback(onFrame);
  };

  const attach = (s: MediaStream) => {
    if (remote === s || finished) return;
    remote = s;
    step("remote_stream", `${s.getVideoTracks().length} video track(s)`);
    const v = o.output;
    v.muted = true;
    v.srcObject = s;
    void Promise.resolve().then(() => v.play()).catch(() => { /* autoplay of a muted video is allowed; frames are what count */ });
    if (typeof v.requestVideoFrameCallback === "function") { counting = true; v.requestVideoFrameCallback(onFrame); }
    else v.addEventListener("loadeddata", () => firstFrame("loadeddata"), { once: true });
  };

  const onState = (s: ConnState, detail?: string, f?: LucyFailure) => {
    if (s === "live") step("connected");
    else if (s === "connecting" && detail) step("reconnecting", detail);
    else if (s === "failed") fail(f ?? { code: "unknown", message: detail ?? "The connection failed" });
  };

  const onTrace = (e: TraceEvent, detail?: string) => {
    if (e === "local_candidate") { if (r.counts.localCandidates++ === 0) step("first_local_candidate", detail); return; }
    if (e === "remote_candidate") { if (r.counts.remoteCandidates++ === 0) step("first_remote_candidate", detail); return; }
    if (e === "server_message") {
      r.counts.serverMessages++;
      if (r.serverMessages.length < MAX_SERVER_MESSAGES) r.serverMessages.push(detail ?? "?");
      if (r.counts.serverMessages <= 10) step("server_message", detail);
      return;
    }
    step(e, detail);
  };

  const observe = (p: RTCPeerConnection) => {
    if (typeof p.addEventListener !== "function") return;
    const opts = { signal: observers.signal };
    p.addEventListener("icegatheringstatechange", () => step("ice_gathering_state", p.iceGatheringState), opts);
    p.addEventListener("iceconnectionstatechange", () => step("ice_connection_state", p.iceConnectionState), opts);
    p.addEventListener("connectionstatechange", () => step("peer_connection_state", p.connectionState), opts);
  };

  async function createSession() {
    let res: Response;
    try {
      res = await o.fetch(DIAG_SESSION_URL, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ prompt: o.prompt }) });
    } catch (e) {
      fail({ code: "session_unreachable", message: `Could not reach ${DIAG_SESSION_URL}: ${errorText(e)}` });
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { sessionId?: unknown; error?: unknown };
    if (res.ok && typeof body.sessionId === "string") {
      r.sessionId = body.sessionId; // kept even if the check was stopped meanwhile, so cleanup ends it
      step("session_created");
      return;
    }
    const why = typeof body.error === "string" ? `: ${body.error}` : "";
    fail({ code: res.status === 503 ? "not_configured" : "session_refused", message: `Diagnostics session refused, HTTP ${res.status}${why}`, status: res.status });
  }

  async function sampleWindow() {
    step("sampling_started");
    const start = now();
    for (;;) {
      if (!pc) break;
      try { r.samples.push(readSample(await pc.getStats(), since(), counting ? presented : null)); } catch (e) { step("stats_error", errorText(e)); }
      emit();
      if (r.failure || now() - start >= PASS_CRITERIA.sampleMs) break;
      await sleep(STATS_INTERVAL_MS);
      if (r.failure) break;
    }
    step("sampling_finished", `${r.samples.length} samples`);
  }

  async function cleanup() {
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    observers.abort();
    const v = o.output;
    const shown = v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null;
    if (conn) { try { conn.close(); } catch { /* already released */ } r.cleanup.connectionClosed = true; }
    if (cam) {
      try { cam.stop(); } catch { /* best effort */ }
      r.cleanup.tracksStopped = cam.stream.getTracks().every((t) => t.readyState === "ended");
    }
    remote?.getTracks().forEach((t) => { try { t.stop(); } catch { /* best effort */ } });
    try { v.srcObject = null; } catch { /* best effort */ }
    r.cleanup.peerClosed = pc ? pc.signalingState === "closed" || pc.connectionState === "closed" : null;
    r.metrics = summarize(r.samples, {
      timeToFirstFrameMs: r.metrics.timeToFirstFrameMs,
      firstFrameSource: r.metrics.firstFrameSource,
      ...(shown ? { resolution: shown } : {}),
    });
    const verdict = evaluate(r);
    if (r.sessionId) {
      const m = r.metrics;
      try {
        const res = await o.fetch(DIAG_END_URL, {
          method: "POST", headers: JSON_HEADERS, keepalive: true,
          body: JSON.stringify({
            sessionId: r.sessionId,
            result: { pass: verdict.pass, failureCode: r.failure?.code ?? null, timeToFirstFrameMs: m.timeToFirstFrameMs, fps: m.fps, rttMs: m.rttMs?.avg ?? null },
          }),
        });
        r.cleanup.sessionEnded = res.ok;
        r.cleanup.sessionEndStatus = res.status;
      } catch {
        r.cleanup.sessionEnded = false;
      }
      step(r.cleanup.sessionEnded ? "session_ended" : "session_end_failed");
    }
    r.verdict = verdict.verdict;
    r.finishedAt = wall().toISOString();
    r.durationMs = since();
    step("finished");
    r.status = verdict.pass ? "pass" : "fail"; // last: watchers (the smoke script) take "pass"/"fail" to mean the report is complete
    emit();
  }

  try {
    try { cam = o.camera(); } catch (e) { fail({ code: "camera_error", message: `Synthetic camera: ${errorText(e)}` }); }
    if (cam) step("synthetic_camera_started", `${cam.stream.getVideoTracks().length} video track(s)`);
    if (!r.failure) await createSession();
    if (!r.failure && cam && r.sessionId) {
      connectAt = now();
      step("connect_started");
      conn = o.connect({ sessionId: r.sessionId, stream: cam.stream, inputs: { prompt: o.prompt, enablePromptExpansion: false }, onRemoteStream: attach, onState, onTrace });
      pc = conn.pc();
      if (pc) observe(pc);
      const deadline = connectAt + FIRST_FRAME_WAIT_MS;
      while (!r.failure && firstFrameAt === null && now() < deadline) await sleep(POLL_MS);
      if (!r.failure && firstFrameAt === null) {
        const connected = pc?.connectionState === "connected";
        fail({ code: "no_first_frame", message: `No transformed video frame within ${FIRST_FRAME_WAIT_MS / 1000} s${connected ? ", although the connection was established" : ""}` });
      }
      if (!r.failure) await sampleWindow();
    }
  } catch (e) {
    fail({ code: "diagnostics_error", message: errorText(e) });
  } finally {
    await cleanup();
  }
  return r;
}
