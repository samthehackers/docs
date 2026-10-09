/**
 * The realtime check's PASS rule and report shape, shared by /admin/diagnostics (which runs the check in the browser and
 * shows the verdict) and scripts/smoke-realtime.ts (which re-applies the rule to the numbers the page reports, so a page
 * that merely claims PASS cannot make the script pass). Pure: no browser, server or network APIs.
 *
 * Documented in docs/REALTIME_VERIFICATION.md. Change the numbers there too.
 */
export const PASS_CRITERIA = {
  /** The first transformed frame must be on screen within this long of starting the connection (token request included). */
  firstFrameMaxMs: 15_000,
  /** Average decoded frame rate of the transformed video over the sample window (getStats `framesDecoded`). */
  minFps: 10,
  /** How long stats are sampled after the first frame. */
  sampleMs: 10_000,
  /** The sample only counts if it covered at least this share of `sampleMs` (a connection that dies after 3 s fails). */
  minSampleCoverage: 0.9,
} as const;

/**
 * The check gives up waiting for a first frame after this long. Longer than the connection's own timeouts (answer 20 s,
 * then ICE 30 s after the answer) so their more specific failure codes are reported first.
 */
export const FIRST_FRAME_WAIT_MS = 55_000;
/** getStats() is read this often during the sample window. */
export const STATS_INTERVAL_MS = 1_000;

export interface DiagStep {
  /** e.g. session_created, token_requested, offer_sent, server_message, answer_applied, first_frame. */
  name: string;
  /** Milliseconds since the check started. */
  atMs: number;
  /** Wall-clock time (ISO 8601). */
  at: string;
  detail?: string;
}

export interface StatSample {
  atMs: number;
  framesDecoded: number | null;
  /** The browser's own instantaneous estimate. */
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  bytesReceived: number | null;
  rttMs: number | null;
  /** Frames presented to the output <video> so far (requestVideoFrameCallback), when available. */
  presentedFrames: number | null;
}

export interface DiagMetrics {
  /** From the start of the connection (just before the token request) to the first transformed frame presented. */
  timeToFirstFrameMs: number | null;
  firstFrameSource: "requestVideoFrameCallback" | "loadeddata" | null;
  resolution: { width: number; height: number } | null;
  /** Decoded frames per second over the sample window, from getStats framesDecoded. This is the PASS number. */
  fps: number | null;
  /** Frames presented to the <video> per second over the window (requestVideoFrameCallback). Informational. */
  displayedFps: number | null;
  rttMs: { avg: number; max: number } | null;
  jitterMs: { avg: number; max: number } | null;
  /** Packets lost / (lost + received) over the sample window, in percent. */
  packetLossPct: number | null;
  /** How long the sample window actually ran. */
  sampleMs: number;
}

export interface DiagFailure { code: string; message: string; status?: number }

export interface DiagnosticsReport {
  tool: "altrcam-realtime-diagnostics";
  version: 1;
  status: "pass" | "fail" | "running";
  verdict: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** The site the check ran on (location.origin). */
  endpoint: string;
  /** The fal app the connection targets. */
  app: string;
  prompt: string;
  criteria: typeof PASS_CRITERIA;
  sessionId: string | null;
  steps: DiagStep[];
  /** The shape (type, or keys) of every message the service sent, in order. Never values. */
  serverMessages: string[];
  counts: { localCandidates: number; remoteCandidates: number; serverMessages: number };
  metrics: DiagMetrics;
  samples: StatSample[];
  failure: DiagFailure | null;
  cleanup: {
    /** Every synthetic camera track reports readyState "ended". */
    tracksStopped: boolean | null;
    /** The peer connection reports "closed" (null: none was created). */
    peerClosed: boolean | null;
    /** close() was called on the connection (it closes the peer and asks the fal client to close the socket). */
    connectionClosed: boolean;
    /** The diagnostics session was ended on the server (null: none was created). */
    sessionEnded: boolean | null;
    sessionEndStatus?: number;
  };
}

export function emptyMetrics(): DiagMetrics {
  return { timeToFirstFrameMs: null, firstFrameSource: null, resolution: null, fps: null, displayedFps: null, rttMs: null, jitterMs: null, packetLossPct: null, sampleMs: 0 };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** PASS or FAIL, with the reason. Applied by the page and, again, by the smoke script. */
export function evaluate(r: { failure: DiagFailure | null; metrics: DiagMetrics }, c = PASS_CRITERIA): { pass: boolean; verdict: string } {
  const m = r.metrics;
  if (r.failure) return { pass: false, verdict: `FAIL: ${r.failure.code}: ${r.failure.message}` };
  if (m.timeToFirstFrameMs === null) return { pass: false, verdict: "FAIL: no transformed video frame arrived" };
  if (m.timeToFirstFrameMs > c.firstFrameMaxMs) return { pass: false, verdict: `FAIL: first frame took ${secs(m.timeToFirstFrameMs)} (limit ${secs(c.firstFrameMaxMs)})` };
  if (m.sampleMs < c.sampleMs * c.minSampleCoverage) return { pass: false, verdict: `FAIL: video was only sampled for ${secs(m.sampleMs)} (need ${secs(c.sampleMs * c.minSampleCoverage)})` };
  if (m.fps === null) return { pass: false, verdict: "FAIL: no frame rate could be measured" };
  if (m.fps < c.minFps) return { pass: false, verdict: `FAIL: ${m.fps.toFixed(1)} fps over the sample (need at least ${c.minFps})` };
  return { pass: true, verdict: `PASS: first frame in ${secs(m.timeToFirstFrameMs)}, ${m.fps.toFixed(1)} fps over ${secs(m.sampleMs)}` };
}

/**
 * Remove credentials from text that may be shown, copied or printed: the fal client puts the short-lived token in the
 * socket URL (`fal_jwt_token=`), and browsers echo that URL in errors. Also Bearer/Key authorization values and JWTs.
 */
export function redact(s: string): string {
  return s
    .replace(/((?:fal_jwt_)?token=)[^&\s"'<>]+/gi, "$1[redacted]")
    .replace(/\b(Bearer|Key)\s+[A-Za-z0-9._:~+/=-]{8,}/g, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]");
}
