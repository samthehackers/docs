/**
 * Turns RTCPeerConnection.getStats() reports into samples, and samples into the check's metrics. Pure (no browser
 * globals), so it is unit-tested with plain objects and exercised against real Chromium stats by
 * tests/public/diagnostics.spec.ts (a local WebRTC loopback, no fal involved).
 */
import { emptyMetrics, type DiagMetrics, type StatSample } from "./criteria";

type Stat = Record<string, unknown> & { type?: string; id?: string };
/** RTCStatsReport, or anything with the same forEach. */
export interface StatsLike { forEach: (cb: (s: unknown) => void) => void }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One sample from one getStats() report. The inbound video stream with the most data wins when there are several. */
export function readSample(report: StatsLike, atMs: number, presentedFrames: number | null = null): StatSample {
  let inbound: Stat | null = null;
  let selectedPair: string | null = null;
  const pairs: Stat[] = [];
  report.forEach((x) => {
    if (!x || typeof x !== "object") return;
    const s = x as Stat;
    if (s.type === "inbound-rtp" && (s.kind ?? s.mediaType) === "video") {
      if (!inbound || (num(s.bytesReceived) ?? 0) > (num(inbound.bytesReceived) ?? 0)) inbound = s;
    } else if (s.type === "transport" && typeof s.selectedCandidatePairId === "string") {
      selectedPair = s.selectedCandidatePairId;
    } else if (s.type === "candidate-pair") {
      pairs.push(s);
    }
  });
  const pair = pairs.find((p) => p.id === selectedPair) ?? pairs.find((p) => p.nominated === true && p.state === "succeeded") ?? null;
  const v = (inbound ?? {}) as Stat;
  const rtt = num(pair?.currentRoundTripTime);
  const jitter = num(v.jitter);
  return {
    atMs,
    framesDecoded: num(v.framesDecoded),
    framesPerSecond: num(v.framesPerSecond),
    frameWidth: num(v.frameWidth),
    frameHeight: num(v.frameHeight),
    jitterMs: jitter === null ? null : round(jitter * 1000, 1),
    packetsLost: num(v.packetsLost),
    packetsReceived: num(v.packetsReceived),
    bytesReceived: num(v.bytesReceived),
    rttMs: rtt === null ? null : round(rtt * 1000, 1),
    presentedFrames,
  };
}

const round = (n: number, dp = 0) => { const f = 10 ** dp; return Math.round(n * f) / f; };

function spread(xs: (number | null)[]): { avg: number; max: number } | null {
  const v = xs.filter((x): x is number => x !== null);
  if (!v.length) return null;
  return { avg: round(v.reduce((a, b) => a + b, 0) / v.length, 1), max: round(Math.max(...v), 1) };
}

/** Rate of a cumulative counter between the first and last samples that have it, per second. */
function rate(samples: StatSample[], pick: (s: StatSample) => number | null): number | null {
  const have = samples.filter((s) => pick(s) !== null);
  if (have.length < 2) return null;
  const a = have[0], b = have[have.length - 1];
  const dt = (b.atMs - a.atMs) / 1000;
  if (dt <= 0) return null;
  return round(((pick(b) as number) - (pick(a) as number)) / dt, 1);
}

/**
 * Metrics over the sample window. `timeToFirstFrameMs` and `resolution` come from the caller (the <video> element knows
 * them best); everything else from the samples.
 */
export function summarize(samples: StatSample[], extra: Partial<Pick<DiagMetrics, "timeToFirstFrameMs" | "firstFrameSource" | "resolution">> = {}): DiagMetrics {
  const m = emptyMetrics();
  Object.assign(m, extra);
  if (samples.length) m.sampleMs = samples[samples.length - 1].atMs - samples[0].atMs;
  m.fps = rate(samples, (s) => s.framesDecoded);
  m.displayedFps = rate(samples, (s) => s.presentedFrames);
  m.rttMs = spread(samples.map((s) => s.rttMs));
  m.jitterMs = spread(samples.map((s) => s.jitterMs));
  const withLoss = samples.filter((s) => s.packetsLost !== null && s.packetsReceived !== null);
  if (withLoss.length >= 2) {
    const a = withLoss[0], b = withLoss[withLoss.length - 1];
    const lost = (b.packetsLost as number) - (a.packetsLost as number);
    const got = (b.packetsReceived as number) - (a.packetsReceived as number);
    m.packetLossPct = lost + got > 0 ? round((Math.max(lost, 0) / (Math.max(lost, 0) + got)) * 100, 2) : 0;
  }
  if (!m.resolution) {
    const last = [...samples].reverse().find((s) => s.frameWidth && s.frameHeight);
    if (last) m.resolution = { width: last.frameWidth as number, height: last.frameHeight as number };
  }
  return m;
}
