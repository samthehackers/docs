/**
 * The realtime check's flow (lib/diagnostics/run.ts), its measuring (lib/diagnostics/measure.ts) and its PASS rule
 * (lib/diagnostics/criteria.ts), with the connection, camera, video element and server faked.
 *
 * What this proves: the check records the steps, computes the numbers it reports from what the browser gives it, applies
 * the PASS rule, and releases everything (connection, camera tracks, remote tracks, server session) on every exit path.
 * What it does NOT prove: anything about fal. The measuring half also runs against real Chromium WebRTC stats in
 * tests/public/diagnostics.spec.ts (a local loopback). Only a run against the real service says whether Lucy works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectOptions, LucyConnection } from "@/lib/fal/signaling";
import { DIAG_END_URL, DIAG_SESSION_URL, runDiagnostics } from "@/lib/diagnostics/run";
import { evaluate, FIRST_FRAME_WAIT_MS, PASS_CRITERIA, redact, emptyMetrics, type DiagnosticsReport, type StatSample } from "@/lib/diagnostics/criteria";
import { readSample, summarize } from "@/lib/diagnostics/measure";

class FakeTrack { readyState = "live"; stop() { this.readyState = "ended"; } }
const fakeStream = () => { const t = [new FakeTrack()]; return { getTracks: () => t, getVideoTracks: () => t } as unknown as MediaStream; };

class FakeVideo {
  srcObject: unknown = null; muted = false; videoWidth = 0; videoHeight = 0;
  cbs: ((t: number, m: { width: number; height: number }) => void)[] = [];
  play = vi.fn(async () => {});
  requestVideoFrameCallback(cb: (t: number, m: { width: number; height: number }) => void) { this.cbs.push(cb); return this.cbs.length; }
  addEventListener() {}
  /** The browser presents one frame. */
  frame(w = 1280, h = 720) { this.videoWidth = w; this.videoHeight = h; for (const cb of this.cbs.splice(0)) cb(0, { width: w, height: h }); }
}

/** A peer whose inbound video decodes `fps` frames per second of fake time from when `startDecoding()` is called. */
class StatsPC {
  signalingState = "stable"; connectionState = "new"; iceConnectionState = "new"; iceGatheringState = "new";
  fps = 25; lossPerSec = 1; recvPerSec = 99; decodeFrom: number | null = null;
  listeners: [string, () => void][] = [];
  addEventListener(t: string, cb: () => void, o?: { signal?: AbortSignal }) { if (!o?.signal?.aborted) this.listeners.push([t, cb]); o?.signal?.addEventListener("abort", () => { this.listeners = this.listeners.filter(([, c]) => c !== cb); }); }
  fire(t: string) { for (const [n, cb] of this.listeners) if (n === t) cb(); }
  startDecoding() { this.decodeFrom = Date.now(); }
  close() { this.signalingState = "closed"; this.connectionState = "closed"; }
  async getStats() {
    const s = this.decodeFrom === null ? 0 : (Date.now() - this.decodeFrom) / 1000;
    return new Map<string, unknown>([
      ["in", { type: "inbound-rtp", kind: "video", framesDecoded: Math.floor(s * this.fps), framesPerSecond: this.fps, frameWidth: 1280, frameHeight: 720, jitter: 0.02, packetsLost: Math.floor(s * this.lossPerSec), packetsReceived: Math.floor(s * this.recvPerSec), bytesReceived: 1000 }],
      ["au", { type: "inbound-rtp", kind: "audio", framesDecoded: 999999 }],
      ["t", { type: "transport", selectedCandidatePairId: "p1" }],
      ["p0", { id: "p0", type: "candidate-pair", currentRoundTripTime: 9, state: "succeeded", nominated: false }],
      ["p1", { id: "p1", type: "candidate-pair", currentRoundTripTime: 0.05, state: "succeeded", nominated: true }],
    ]);
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let video: FakeVideo, pc: StatsPC, conn: { opts: ConnectOptions | null; closed: number }, camera: { stream: MediaStream; stop: ReturnType<typeof vi.fn> } | null;
let fetchMock: ReturnType<typeof vi.fn<Fetch>>;
let connectMock: ReturnType<typeof vi.fn>;
let sessionResponse: () => Response | Promise<Response>;
let endResponse: () => Response | Promise<Response>;

function setup() {
  video = new FakeVideo(); pc = new StatsPC(); conn = { opts: null, closed: 0 }; camera = null;
  sessionResponse = () => json(200, { sessionId: "11111111-1111-4111-8111-111111111111" });
  endResponse = () => json(200, { ended: true });
  fetchMock = vi.fn<Fetch>(async (url) => (url === DIAG_SESSION_URL ? sessionResponse() : url === DIAG_END_URL ? endResponse() : json(404, {})));
  connectMock = vi.fn((o: ConnectOptions): LucyConnection => {
    conn.opts = o;
    o.onState("connecting");
    let released = false;
    return { pc: () => (released ? null : (pc as unknown as RTCPeerConnection)), close: () => { conn.closed++; if (!released) { released = true; pc.close(); o.onState("closed"); } } };
  });
}

function start(extra: { signal?: AbortSignal; onProgress?: (r: DiagnosticsReport) => void } = {}) {
  return runDiagnostics({
    fetch: fetchMock, connect: connectMock as unknown as (o: ConnectOptions) => LucyConnection,
    camera: () => { const stream = fakeStream(); camera = { stream, stop: vi.fn(() => stream.getTracks().forEach((t) => t.stop())) }; return camera; },
    output: video as unknown as HTMLVideoElement,
    endpoint: "https://preview.example", app: "decart/lucy-2-5/realtime", prompt: "a test prompt",
    now: () => Date.now(), wallClock: () => new Date(),
    onProgress: extra.onProgress,
  }, extra.signal);
}

/** Drive a successful handshake through the hooks connectLucy really calls. */
async function handshake() {
  const o = conn.opts!;
  for (const e of ["token_requested", "token_received", "offer_created", "offer_sent"] as const) o.onTrace!(e);
  o.onTrace!("local_candidate", "host"); o.onTrace!("local_candidate", "srflx");
  o.onTrace!("server_message", "type=answer");
  o.onTrace!("outbox_flushed", "2");
  o.onTrace!("answer_applied");
  o.onTrace!("remote_candidate");
  pc.connectionState = "connected"; pc.fire("connectionstatechange");
  o.onState("live");
  o.onTrace!("remote_track");
  o.onRemoteStream(fakeStream());
}

const endCall = () => fetchMock.mock.calls.find(([u]) => u === DIAG_END_URL);
const endBody = () => JSON.parse(String(endCall()?.[1]?.body)) as { sessionId: string; result: Record<string, unknown> };
const names = (r: DiagnosticsReport) => r.steps.map((s) => s.name);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T12:00:00Z")); setup(); });
afterEach(() => { vi.useRealTimers(); });

describe("a passing check", () => {
  it("records every step with timestamps, measures the video and releases everything", async () => {
    // The session takes 700 ms: TTFF counts from the start of the connection, not from the start of the check.
    sessionResponse = () => new Promise<Response>((res) => setTimeout(() => res(json(200, { sessionId: "11111111-1111-4111-8111-111111111111" })), 700));
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connectMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(conn.opts).toMatchObject({ sessionId: "11111111-1111-4111-8111-111111111111", inputs: { prompt: "a test prompt", enablePromptExpansion: false } });
    expect(conn.opts!.stream).toBe(camera!.stream); // the synthetic camera is what gets sent
    await vi.advanceTimersByTimeAsync(1500);
    await handshake();
    await vi.advanceTimersByTimeAsync(500);
    pc.startDecoding(); video.frame(); // first frame 2 s after connect started
    await vi.advanceTimersByTimeAsync(PASS_CRITERIA.sampleMs + 2000);
    const r = await p;

    expect(r.status).toBe("pass");
    expect(r.verdict).toBe("PASS: first frame in 2.0 s, 25.0 fps over 10.0 s");
    expect(names(r)).toEqual([
      "synthetic_camera_started", "session_created", "connect_started",
      "token_requested", "token_received", "offer_created", "offer_sent", "first_local_candidate", "server_message", "outbox_flushed",
      "answer_applied", "first_remote_candidate", "peer_connection_state", "connected", "remote_track", "remote_stream", "first_frame",
      "sampling_started", "sampling_finished", "session_ended", "finished",
    ]);
    expect(r.steps.find((s) => s.name === "connect_started")).toMatchObject({ atMs: 700 });
    expect(r.steps.find((s) => s.name === "first_frame")).toMatchObject({ atMs: 2700, at: "2026-10-09T12:00:02.700Z", detail: "1280x720" });
    expect(r.steps.every((s, i) => i === 0 || s.atMs >= r.steps[i - 1].atMs)).toBe(true);
    expect(r.serverMessages).toEqual(["type=answer"]);
    expect(r.counts).toEqual({ localCandidates: 2, remoteCandidates: 1, serverMessages: 1 });
    expect(r.metrics).toMatchObject({
      timeToFirstFrameMs: 2000, firstFrameSource: "requestVideoFrameCallback", resolution: { width: 1280, height: 720 },
      fps: 25, rttMs: { avg: 50, max: 50 }, jitterMs: { avg: 20, max: 20 }, packetLossPct: 1, sampleMs: 10000,
    });
    expect(r.samples).toHaveLength(11);
    expect(r.failure).toBeNull();

    // Everything closed: connection (peer + socket), camera tracks, the remote video, the server session.
    expect(conn.closed).toBe(1);
    expect(camera!.stop).toHaveBeenCalledTimes(1);
    expect(r.cleanup).toEqual({ tracksStopped: true, peerClosed: true, connectionClosed: true, sessionEnded: true, sessionEndStatus: 200 });
    expect(video.srcObject).toBeNull();
    expect(pc.listeners).toEqual([]); // our state observers are removed
    expect(endBody()).toEqual({ sessionId: "11111111-1111-4111-8111-111111111111", result: { pass: true, failureCode: null, timeToFirstFrameMs: 2000, fps: 25, rttMs: 50 } });
    expect(endCall()?.[1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("only reports pass/fail when the report is complete (the smoke script waits for that)", async () => {
    const seen: string[] = [];
    const p = start({ onProgress: (r) => seen.push(r.status) });
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(PASS_CRITERIA.sampleMs + 2000);
    const r = await p;
    expect(seen.slice(0, -1).every((s) => s === "running")).toBe(true);
    expect(seen.at(-1)).toBe("pass");
    expect(r.finishedAt).not.toBeNull();
  });
});

describe("failing checks", () => {
  it("fails a first frame slower than the limit, but still measures and cleans up", async () => {
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    await handshake();
    await vi.advanceTimersByTimeAsync(16_000);
    pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(PASS_CRITERIA.sampleMs + 2000);
    const r = await p;
    expect(r.status).toBe("fail");
    expect(r.verdict).toBe("FAIL: first frame took 16.0 s (limit 15.0 s)");
    expect(r.metrics.fps).toBe(25);
    expect(r.cleanup.sessionEnded).toBe(true);
  });

  it("fails a frame rate under the minimum", async () => {
    pc.fps = 8;
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(PASS_CRITERIA.sampleMs + 2000);
    const r = await p;
    expect(r.verdict).toBe("FAIL: 8.0 fps over the sample (need at least 10)");
    expect(endBody().result).toMatchObject({ pass: false, fps: 8 });
  });

  it.each([
    [403, { error: "Forbidden" }, "session_refused", "Diagnostics session refused, HTTP 403: Forbidden"],
    [401, { error: "Unauthorized" }, "session_refused", "Diagnostics session refused, HTTP 401: Unauthorized"],
    [503, { error: "Live transformation isn't configured", code: "unavailable" }, "not_configured", "Diagnostics session refused, HTTP 503: Live transformation isn't configured"],
  ])("a refused diagnostics session (%i) never connects, and stops the camera", async (status, body, code, message) => {
    sessionResponse = () => json(status, body);
    const r = await start();
    expect(r.failure).toEqual({ code, message, status });
    expect(r.status).toBe("fail");
    expect(connectMock).not.toHaveBeenCalled();
    expect(endCall()).toBeUndefined(); // there is no session to end
    expect(r.cleanup).toMatchObject({ tracksStopped: true, peerClosed: null, connectionClosed: false, sessionEnded: null });
  });

  it("reports an unreachable server", async () => {
    sessionResponse = () => { throw new TypeError("Failed to fetch"); };
    const r = await start();
    expect(r.failure).toMatchObject({ code: "session_unreachable" });
    expect(r.cleanup.tracksStopped).toBe(true);
  });

  it("reports the connection's own failure code and status, and still ends the session", async () => {
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    conn.opts!.onTrace!("token_requested");
    conn.opts!.onTrace!("token_failed", "Token request refused: HTTP 403 (No active studio session)");
    conn.opts!.onState("failed", "Token request refused: HTTP 403 (No active studio session)", { code: "token_refused", message: "Token request refused: HTTP 403 (No active studio session)", status: 403 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.failure).toEqual({ code: "token_refused", message: "Token request refused: HTTP 403 (No active studio session)", status: 403 });
    expect(r.verdict).toBe("FAIL: token_refused: Token request refused: HTTP 403 (No active studio session)");
    expect(names(r)).toContain("token_failed");
    expect(endBody().result).toMatchObject({ pass: false, failureCode: "token_refused" });
    expect(r.cleanup).toMatchObject({ tracksStopped: true, connectionClosed: true, sessionEnded: true });
  });

  it("gives up after the wait when no frame ever arrives, saying whether the connection was up", async () => {
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); // connected, a stream arrived, but no frame is ever presented
    await vi.advanceTimersByTimeAsync(FIRST_FRAME_WAIT_MS + 1000);
    const r = await p;
    expect(r.failure).toEqual({ code: "no_first_frame", message: `No transformed video frame within ${FIRST_FRAME_WAIT_MS / 1000} s, although the connection was established` });
    expect(conn.closed).toBe(1);
    expect(r.cleanup.sessionEnded).toBe(true);
  });

  it("fails when the connection drops during the sample", async () => {
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(4000);
    conn.opts!.onState("failed", "Disconnected and did not recover", { code: "connection_lost", message: "Disconnected and did not recover" });
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.failure?.code).toBe("connection_lost");
    expect(r.samples.length).toBeLessThan(7);
    expect(r.cleanup.sessionEnded).toBe(true);
  });

  it("can be stopped, and stops cleanly", async () => {
    const ac = new AbortController();
    const p = start({ signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(3000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1500);
    const r = await p;
    expect(r.failure?.code).toBe("aborted");
    expect(r.cleanup).toMatchObject({ tracksStopped: true, peerClosed: true, connectionClosed: true, sessionEnded: true });
  });

  it("a connection that throws while starting is reported and everything is still released", async () => {
    connectMock.mockImplementationOnce(() => { throw new Error("RTCPeerConnection is not defined"); });
    const r = await start();
    expect(r.failure).toMatchObject({ code: "diagnostics_error", message: "RTCPeerConnection is not defined" });
    expect(r.cleanup).toMatchObject({ tracksStopped: true, sessionEnded: true });
  });

  it("a session that cannot be ended is reported, without changing the verdict", async () => {
    endResponse = () => json(500, { error: "Internal error" });
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    await handshake(); pc.startDecoding(); video.frame();
    await vi.advanceTimersByTimeAsync(PASS_CRITERIA.sampleMs + 2000);
    const r = await p;
    expect(r.status).toBe("pass");
    expect(r.cleanup).toMatchObject({ sessionEnded: false, sessionEndStatus: 500 });
    expect(names(r)).toContain("session_end_failed");
  });
});

describe("credentials never reach the report", () => {
  it("redacts the fal token from a socket error the browser echoes", async () => {
    const p = start();
    await vi.advanceTimersByTimeAsync(0);
    const message = "WebSocket connection to 'wss://fal.run/decart/lucy-2-5/realtime?fal_jwt_token=eyJhbGciOi.eyJzdWIiOiJ4In0.c2ln&max_buffering=5' failed";
    conn.opts!.onState("failed", message, { code: "socket_error", message, status: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    const r = await p;
    const text = JSON.stringify(r);
    expect(text).not.toContain("eyJhbGciOi");
    expect(r.failure?.message).toContain("fal_jwt_token=[redacted]");
  });
  it("redact() covers tokens in URLs, authorization values and bare JWTs", () => {
    expect(redact("x?token=abc123&y=1")).toBe("x?token=[redacted]&y=1");
    expect(redact("Authorization: Key fal-key-1234567890")).toBe("Authorization: Key [redacted]");
    expect(redact("Bearer abcdefghijklmnop")).toBe("Bearer [redacted]");
    expect(redact("jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f")).toBe("jwt [redacted-jwt]");
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});

describe("measuring", () => {
  const S = (atMs: number, o: Partial<StatSample> = {}): StatSample => ({ atMs, framesDecoded: null, framesPerSecond: null, frameWidth: null, frameHeight: null, jitterMs: null, packetsLost: null, packetsReceived: null, bytesReceived: null, rttMs: null, presentedFrames: null, ...o });

  it("reads the video stream, ignores audio, and takes RTT from the selected candidate pair", async () => {
    pc.startDecoding();
    vi.advanceTimersByTime(2000);
    expect(readSample(await pc.getStats(), 7, 33)).toEqual({ atMs: 7, framesDecoded: 50, framesPerSecond: 25, frameWidth: 1280, frameHeight: 720, jitterMs: 20, packetsLost: 2, packetsReceived: 198, bytesReceived: 1000, rttMs: 50, presentedFrames: 33 });
  });
  it("falls back to the nominated, succeeded pair when no transport names one; picks the inbound video with the most data", () => {
    const report = new Map<string, unknown>([
      ["a", { type: "inbound-rtp", kind: "video", bytesReceived: 10, framesDecoded: 1 }],
      ["b", { type: "inbound-rtp", mediaType: "video", bytesReceived: 500, framesDecoded: 99 }],
      ["p", { id: "p", type: "candidate-pair", currentRoundTripTime: 0.1234, state: "succeeded", nominated: true }],
    ]);
    expect(readSample(report, 0)).toMatchObject({ framesDecoded: 99, rttMs: 123.4, jitterMs: null });
  });
  it("returns nulls, not zeros, for what the browser does not report", () => {
    expect(readSample(new Map(), 0)).toEqual(S(0));
    expect(summarize([S(0), S(1000)])).toEqual({ ...emptyMetrics(), sampleMs: 1000 });
  });
  it("computes rates and loss over the window from cumulative counters", () => {
    const m = summarize([S(0, { framesDecoded: 100, presentedFrames: 90, packetsLost: 10, packetsReceived: 1000, rttMs: 40, jitterMs: 5 }), S(5000, { framesDecoded: 175, presentedFrames: 140, packetsLost: 15, packetsReceived: 1495, rttMs: 60, jitterMs: 15, frameWidth: 640, frameHeight: 360 })]);
    expect(m).toMatchObject({ fps: 15, displayedFps: 10, packetLossPct: 1, rttMs: { avg: 50, max: 60 }, jitterMs: { avg: 10, max: 15 }, sampleMs: 5000, resolution: { width: 640, height: 360 } });
  });
});

describe("the PASS rule", () => {
  const ok = { ...emptyMetrics(), timeToFirstFrameMs: 15_000, fps: 10, sampleMs: 9_000 };
  it("passes exactly at each limit", () => { expect(evaluate({ failure: null, metrics: ok }).pass).toBe(true); });
  it.each([
    [{ timeToFirstFrameMs: 15_001 }, "FAIL: first frame took 15.0 s (limit 15.0 s)"],
    [{ fps: 9.9 }, "FAIL: 9.9 fps over the sample (need at least 10)"],
    [{ sampleMs: 8_999 }, "FAIL: video was only sampled for 9.0 s (need 9.0 s)"],
    [{ timeToFirstFrameMs: null }, "FAIL: no transformed video frame arrived"],
    [{ fps: null }, "FAIL: no frame rate could be measured"],
  ])("fails %o", (change, verdict) => {
    expect(evaluate({ failure: null, metrics: { ...ok, ...change } })).toEqual({ pass: false, verdict });
  });
  it("any failure fails, whatever the numbers", () => {
    expect(evaluate({ failure: { code: "model_error", message: "bad prompt" }, metrics: { ...ok, fps: 30 } })).toEqual({ pass: false, verdict: "FAIL: model_error: bad prompt" });
  });
  it("is the documented rule", () => {
    expect(PASS_CRITERIA).toEqual({ firstFrameMaxMs: 15_000, minFps: 10, sampleMs: 10_000, minSampleCoverage: 0.9 });
  });
});
