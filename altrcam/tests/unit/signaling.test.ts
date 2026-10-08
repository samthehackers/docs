/**
 * Lucy connection lifecycle (lib/fal/signaling.ts) with fal and WebRTC faked.
 * Verifies the handshake order and, above all, that every exit path releases the peer connection,
 * the socket and the timers, and that nothing fires after close.
 *
 * What this does NOT prove: that fal's real message names match. See README_LIMITATIONS.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  socket: { send: vi.fn(), close: vi.fn() },
  config: vi.fn(),
  opts: null as null | { onResult: (m: unknown) => void; onError?: (e: unknown) => void },
}));
vi.mock("@fal-ai/client", () => ({
  fal: { config: h.config, realtime: { connect: vi.fn((_app: string, opts: typeof h.opts) => { h.opts = opts; return h.socket; }) } },
}));

class FakePC {
  static all: FakePC[] = [];
  config: unknown; tracks: unknown[] = []; closed = false;
  localDescription: unknown = null; remoteDescription: unknown = null; candidates: unknown[] = [];
  connectionState = "new";
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(config: unknown) { this.config = config; FakePC.all.push(this); }
  addTrack(t: unknown) { this.tracks.push(t); }
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async setLocalDescription(d: unknown) { this.localDescription = d; }
  async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  close() { this.closed = true; }
  setState(s: string) { this.connectionState = s; this.onconnectionstatechange?.(); }
  async getStats() {
    return new Map<string, unknown>([
      ["v", { type: "inbound-rtp", kind: "video", framesPerSecond: 24.6, jitter: 0.012, packetsLost: 5, packetsReceived: 95 }],
      ["c", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.0421 }],
    ]);
  }
}

import { connectLucy, readStats, type ConnState } from "@/lib/fal/signaling";

const flush = () => vi.advanceTimersByTimeAsync(0);
const stream = { getTracks: () => [{ id: "cam-track" }] } as unknown as MediaStream;
const pc = () => FakePC.all[FakePC.all.length - 1];

function start(inputs = { prompt: "an astronaut", enablePromptExpansion: true } as { prompt: string; enablePromptExpansion: boolean; referenceImageUrl?: string }) {
  const states: [ConnState, string | undefined][] = [];
  const remote: unknown[] = [];
  const conn = connectLucy({ sessionId: "sess-1", stream, inputs, onRemoteStream: (s) => remote.push(s), onState: (s, d) => states.push([s, d]) });
  return { conn, states, remote, last: () => states[states.length - 1]?.[0] };
}
const msg = (m: unknown) => h.opts!.onResult(m);
const sent = () => h.socket.send.mock.calls.map((c) => c[0] as { type: string; [k: string]: unknown });

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = []; h.socket.send.mockClear(); h.socket.close.mockClear(); h.config.mockClear();
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC;
});
afterEach(() => { vi.useRealTimers(); });

describe("handshake", () => {
  it("authenticates token requests with the studio session header", async () => {
    start();
    const cfg = h.config.mock.calls[0][0];
    expect(cfg.proxyUrl).toBe("/api/fal/proxy");
    const out = await cfg.requestMiddleware({ url: "u", method: "POST", headers: { a: "b" } });
    expect(out.headers).toMatchObject({ a: "b", "x-altrcam-session": "sess-1" });
  });

  it("waits for ICE servers, then creates the peer with them, adds the camera track and sends one offer", async () => {
    const { states } = start();
    expect(states).toEqual([["connecting", undefined]]);
    expect(FakePC.all.length).toBe(0); // nothing created before ICE servers arrive
    msg({ type: "ice_servers", ice_servers: [{ urls: "turn:t.example", username: "u", credential: "c" }] });
    await flush();
    expect(pc().config).toEqual({ iceServers: [{ urls: "turn:t.example", username: "u", credential: "c" }] });
    expect(pc().tracks).toEqual([{ id: "cam-track" }]);
    expect(sent().filter((s) => s.type === "offer")).toEqual([{ type: "offer", sdp: "offer-sdp", prompt: "an astronaut", enable_prompt_expansion: true }]);
  });

  it("only sends reference_image_url when one was provided", async () => {
    start({ prompt: "p", enablePromptExpansion: false, referenceImageUrl: "https://signed.example/ref.jpg" });
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    expect(sent()[0]).toMatchObject({ reference_image_url: "https://signed.example/ref.jpg", enable_prompt_expansion: false });
  });

  it("falls back to a public STUN server if ICE servers never arrive (once)", async () => {
    start();
    await vi.advanceTimersByTimeAsync(3100);
    expect(FakePC.all.length).toBe(1);
    expect(pc().config).toEqual({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:late" }] }); // late arrival must not create a second peer
    await flush();
    expect(FakePC.all.length).toBe(1);
    expect(sent().filter((s) => s.type === "offer").length).toBe(1);
  });

  it("applies the answer, buffers ICE that arrives early, and forwards local candidates", async () => {
    start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    msg({ type: "ice_candidate", candidate: { candidate: "early" } }); // before the answer
    await flush();
    expect(pc().candidates).toEqual([]);
    msg({ type: "answer", sdp: "answer-sdp" });
    await flush();
    expect(pc().remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(pc().candidates).toEqual([{ candidate: "early" }]);
    msg({ type: "ice_candidate", candidate: { candidate: "later" } });
    await flush();
    expect(pc().candidates).toHaveLength(2);
    pc().onicecandidate!({ candidate: { toJSON: () => ({ candidate: "mine" }) } });
    expect(sent().some((s) => s.type === "ice_candidate" && (s.candidate as { candidate: string }).candidate === "mine")).toBe(true);
    pc().onicecandidate!({ candidate: null }); // end-of-candidates sends nothing
    expect(sent().filter((s) => s.type === "ice_candidate").length).toBe(1);
  });

  it("goes live when the peer connects and hands over the remote stream", async () => {
    const { last, remote } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    const media = { id: "remote" };
    pc().ontrack!({ streams: [media] });
    pc().setState("connected");
    expect(remote).toEqual([media]);
    expect(last()).toBe("live");
  });
});

describe("cleanup on every exit path", () => {
  const released = (n = 1) => { expect(pc().closed).toBe(true); expect(h.socket.close).toHaveBeenCalledTimes(n); };

  it("user stop: closes the peer and the socket once, reports closed, and is idempotent", async () => {
    const { conn, states } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // answer timeout is armed
    conn.close(); conn.close(); conn.close();
    released(1);
    expect(vi.getTimerCount()).toBe(0); // and cleared on stop
    expect(states.filter(([s]) => s === "closed").length).toBe(1);
  });

  it("stopping before ICE servers arrive leaves no timer behind that would later create a peer", async () => {
    const { conn } = start();
    conn.close();
    expect(vi.getTimerCount()).toBe(0); // the ICE-fallback timer must be cleared, not merely ignored
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePC.all.length).toBe(0);
    expect(sent().length).toBe(0);
    expect(h.socket.close).toHaveBeenCalledTimes(1);
  });

  it("no answer within 20 s: fails with a clear message and releases everything", async () => {
    const { states, last } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    await vi.advanceTimersByTimeAsync(20_100);
    expect(last()).toBe("closed");
    expect(states.find(([s]) => s === "failed")?.[1]).toMatch(/timed out/i);
    released(1);
  });

  it("model error message: fails with its message and releases everything", async () => {
    const { states } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    msg({ type: "error", message: "quota exceeded" });
    await flush();
    expect(states.find(([s]) => s === "failed")?.[1]).toBe("quota exceeded");
    released(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("socket error (e.g. token refused): fails and releases", () => {
    const { states } = start();
    h.opts!.onError!({ message: "401 Unauthorized" });
    expect(states.find(([s]) => s === "failed")?.[1]).toBe("401 Unauthorized");
    expect(h.socket.close).toHaveBeenCalledTimes(1);
  });

  it("peer connection failure: fails and releases", async () => {
    const { states } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    pc().setState("failed");
    expect(states.map(([s]) => s)).toContain("failed");
    released(1);
  });

  it("a temporary disconnect shows 'reconnecting' but does not tear down", async () => {
    const { states } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    pc().setState("disconnected");
    expect(states[states.length - 1]).toEqual(["connecting", "Reconnecting…"]);
    expect(pc().closed).toBe(false);
  });

  it("nothing fires after close: late messages, timers and callbacks are ignored", async () => {
    const { conn, states } = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    const sentBefore = sent().length;
    const before = states.length;
    conn.close();
    msg({ type: "answer", sdp: "late" });
    msg({ type: "error", message: "late error" });
    h.opts!.onError!({ message: "late socket error" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent().length).toBe(sentBefore);
    expect(states.length).toBe(before + 1); // only the "closed" from close()
    expect(pc().remoteDescription).toBeNull();
  });

  it("restarting (Apply changes) opens a fresh peer without leaking the old one", async () => {
    const a = start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    const first = pc();
    a.conn.close();
    start();
    msg({ type: "ice_servers", ice_servers: [{ urls: "stun:s" }] });
    await flush();
    expect(first.closed).toBe(true);
    expect(pc()).not.toBe(first);
    expect(pc().closed).toBe(false);
  });
});

describe("readStats", () => {
  it("extracts fps, rtt, jitter and loss", async () => {
    const s = await readStats(new FakePC({}) as unknown as RTCPeerConnection);
    expect(s).toEqual({ fps: 25, rttMs: 42, jitterMs: 12, lossPct: 5 });
  });
});
