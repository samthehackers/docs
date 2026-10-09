/**
 * Lucy connection lifecycle (lib/fal/signaling.ts) with fal and WebRTC faked.
 * Verifies the handshake order and, above all, that every exit path releases the peer connection,
 * the socket and the timers, that nothing fires after close, and that a failure keeps its reason.
 *
 * The fal client is replaced by a mock whose socket is always open and delivers messages on demand, which is
 * convenient for lifecycle checks but says nothing about how the real client orders messages. That is what
 * signaling-real-client.test.ts is for (it runs the real pinned client).
 *
 * What this does NOT prove: that fal's real message names match. See README_LIMITATIONS.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePC } from "./fake-browser";

const h = vi.hoisted(() => ({
  socket: { send: vi.fn(), close: vi.fn() },
  connect: null as unknown as ReturnType<typeof vi.fn>,
  opts: null as null | { onResult: (m: unknown) => void; onError?: (e: unknown) => void },
}));
vi.mock("@fal-ai/client", () => {
  h.connect = vi.fn((_app: string, opts: typeof h.opts) => { h.opts = opts; return h.socket; });
  return { fal: { realtime: { connect: h.connect } } };
});

import { connectLucy, readStats, type ConnState, type LucyFailure } from "@/lib/fal/signaling";

const flush = () => vi.advanceTimersByTimeAsync(0);
const stream = { getTracks: () => [{ id: "cam-track" }] } as unknown as MediaStream;
const pc = () => FakePC.all[FakePC.all.length - 1];
const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

function start(inputs = { prompt: "an astronaut", enablePromptExpansion: true } as { prompt: string; enablePromptExpansion: boolean; referenceImageUrl?: string }) {
  const states: [ConnState, string | undefined, LucyFailure | undefined][] = [];
  const remote: unknown[] = [];
  const conn = connectLucy({ sessionId: "sess-1", stream, inputs, onRemoteStream: (s) => remote.push(s), onState: (s, d, f) => states.push([s, d, f]) });
  return { conn, states, remote, last: () => states[states.length - 1]?.[0], failure: () => states.find(([s]) => s === "failed")?.[2] };
}
const msg = (m: unknown) => h.opts!.onResult(m);
const sent = () => h.socket.send.mock.calls.map((c) => c[0] as { type: string; [k: string]: unknown });
/** The usual first reply from the service. */
const answer = async () => { msg({ type: "answer", sdp: "answer-sdp" }); await flush(); };

beforeEach(() => {
  vi.useFakeTimers();
  FakePC.all = []; FakePC.holdNextOffer = null; h.socket.send.mockClear(); h.socket.close.mockClear(); h.connect.mockClear();
  (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC;
});
afterEach(() => { vi.useRealTimers(); });

describe("handshake", () => {
  it("authenticates by supplying its own token provider (so a refused token can be reported)", () => {
    start();
    expect(typeof (h.connect.mock.calls[0][1] as { tokenProvider?: unknown }).tokenProvider).toBe("function");
  });

  it("does not wait for the service: creates the peer with public STUN, adds the camera track and sends one offer at once", async () => {
    const { states } = start();
    expect(states.map(([s]) => s)).toEqual(["connecting"]);
    await flush(); // microtasks only, no timer advanced and no message received
    expect(pc().config).toEqual({ iceServers: STUN });
    expect(pc().tracks).toEqual([{ id: "cam-track" }]);
    expect(sent()).toEqual([{ type: "offer", sdp: "offer-sdp", prompt: "an astronaut", enable_prompt_expansion: true }]);
  });

  it("only sends reference_image_url when one was provided", async () => {
    start({ prompt: "p", enablePromptExpansion: false, referenceImageUrl: "https://signed.example/ref.jpg" });
    await flush();
    expect(sent()[0]).toMatchObject({ reference_image_url: "https://signed.example/ref.jpg", enable_prompt_expansion: false });
  });

  it("ignores ice_servers messages, whenever they arrive: the offer was made before the service could say anything", async () => {
    start();
    await flush();
    msg({ type: "ice_servers", ice_servers: [{ urls: "turn:t.example", username: "u", credential: "c" }] });
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakePC.all.length).toBe(1);
    expect(pc().config).toEqual({ iceServers: STUN });
    expect(sent().filter((s) => s.type === "offer").length).toBe(1);
  });

  it("holds local ICE candidates until the first reply, then sends them in order after the offer", async () => {
    start();
    await flush();
    pc().candidate("c1"); pc().candidate("c2");
    expect(sent().map((s) => s.type)).toEqual(["offer"]);
    await answer();
    expect(sent().map((s) => s.type)).toEqual(["offer", "ice_candidate", "ice_candidate"]);
    expect(sent().slice(1).map((s) => (s.candidate as { candidate: string }).candidate)).toEqual(["c1", "c2"]);
    pc().candidate("c3"); // after the first reply: straight out
    expect(sent().length).toBe(4);
    pc().onicecandidate!({ candidate: null }); // end-of-candidates sends nothing
    expect(sent().length).toBe(4);
  });

  it("a candidate produced while the offer is still being made waits behind it and behind the first reply", async () => {
    let release!: () => void;
    FakePC.holdNextOffer = new Promise<void>((r) => { release = r; });
    start();
    await flush();
    pc().candidate("too-early"); // the browser can hand one over before our offer has even been sent
    expect(sent().length).toBe(0);
    release();
    await flush();
    expect(sent().map((s) => s.type)).toEqual(["offer"]);
    await answer();
    expect(sent().map((s) => s.type)).toEqual(["offer", "ice_candidate"]);
  });

  it("any first reply releases the held candidates, even one whose type we do not know", async () => {
    start();
    await flush();
    pc().candidate("c1");
    msg({ type: "hello_from_the_service" });
    await flush();
    expect(sent().map((s) => s.type)).toEqual(["offer", "ice_candidate"]);
  });

  it("applies the answer and buffers remote ICE that arrives before it", async () => {
    start();
    await flush();
    msg({ type: "ice_candidate", candidate: { candidate: "early" } }); // the first reply is a candidate, before the answer
    await flush();
    expect(pc().candidates).toEqual([]);
    msg({ type: "answer", sdp: "answer-sdp" });
    await flush();
    expect(pc().remoteDescription).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(pc().candidates).toEqual([{ candidate: "early" }]);
    msg({ type: "ice_candidate", candidate: { candidate: "later" } });
    await flush();
    expect(pc().candidates).toHaveLength(2);
  });

  it("goes live when the peer connects and hands over the remote stream", async () => {
    const { last, remote } = start();
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
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // answer timeout is armed
    conn.close(); conn.close(); conn.close();
    released(1);
    expect(vi.getTimerCount()).toBe(0); // and cleared on stop
    expect(states.filter(([s]) => s === "closed").length).toBe(1);
  });

  it("stopping before the offer exists leaves no timer behind and sends nothing", async () => {
    let release!: () => void;
    FakePC.holdNextOffer = new Promise<void>((r) => { release = r; });
    const { conn } = start();
    await flush();
    conn.close();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(sent().length).toBe(0); // no offer sent after close: the real client would reopen a socket for it
    expect(h.socket.close).toHaveBeenCalledTimes(1);
  });

  it("detaches every peer callback when it releases the peer", async () => {
    const { conn } = start();
    await flush();
    conn.close();
    expect(pc().onicecandidate).toBeNull();
    expect(pc().ontrack).toBeNull();
    expect(pc().onconnectionstatechange).toBeNull();
  });

  it("a callback captured before close cannot send afterwards", async () => {
    start();
    await flush();
    await answer(); // from here candidates go straight out
    const captured = pc().onicecandidate!;
    h.opts!.onError!({ message: "boom" }); // fail → release
    const before = sent().length;
    captured({ candidate: { toJSON: () => ({ candidate: "ghost" }) } });
    expect(sent().length).toBe(before);
  });

  it("no answer within 20 s: fails with a clear code and releases everything, without a trailing 'closed'", async () => {
    const { states, last, failure } = start();
    await flush();
    await vi.advanceTimersByTimeAsync(20_100);
    expect(last()).toBe("failed");
    expect(states.map(([s]) => s)).toEqual(["connecting", "failed"]);
    expect(failure()).toMatchObject({ code: "answer_timeout" });
    expect(failure()?.message).toMatch(/timed out/i);
    released(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("model error message: fails with its message and releases everything", async () => {
    const { failure, last } = start();
    await flush();
    msg({ type: "error", message: "quota exceeded" });
    await flush();
    expect(failure()).toEqual({ code: "model_error", message: "quota exceeded" });
    expect(last()).toBe("failed");
    released(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer the browser cannot apply fails as bad_answer", async () => {
    const { failure } = start();
    await flush();
    pc().setRemoteDescription = async () => { throw new TypeError("Failed to parse SessionDescription"); };
    msg({ type: "answer" }); // wrong field name: no sdp
    await flush();
    expect(failure()).toMatchObject({ code: "bad_answer" });
    expect(failure()?.message).toContain("Failed to parse");
    released(1);
  });

  it("socket error (e.g. closed abnormally): fails as socket_error with its status and releases", async () => {
    const { failure, last } = start();
    await flush();
    h.opts!.onError!({ message: "Error closing the connection: gone", status: 1006 });
    expect(failure()).toEqual({ code: "socket_error", message: "Error closing the connection: gone", status: 1006 });
    expect(last()).toBe("failed");
    expect(h.socket.close).toHaveBeenCalledTimes(1);
  });

  it("peer connection failure: fails as ice_failed and releases", async () => {
    const { failure, last } = start();
    await flush();
    pc().setState("failed");
    expect(failure()).toMatchObject({ code: "ice_failed" });
    expect(last()).toBe("failed");
    released(1);
  });

  it("a temporary disconnect shows 'reconnecting' but does not tear down, and recovering cancels the countdown", async () => {
    const { states, last } = start();
    await flush();
    pc().setState("disconnected");
    expect(states[states.length - 1].slice(0, 2)).toEqual(["connecting", "Reconnecting…"]);
    expect(pc().closed).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    pc().setState("connected");
    expect(last()).toBe("live");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last()).toBe("live");
    expect(pc().closed).toBe(false);
  });

  it("a disconnect that never recovers ends in connection_lost instead of 'Reconnecting…' forever", async () => {
    const { failure, last } = start();
    await flush();
    msg({ type: "answer", sdp: "a" });
    await flush();
    pc().setState("disconnected");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(last()).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(last()).toBe("failed");
    expect(failure()).toMatchObject({ code: "connection_lost" });
    released(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("nothing fires after close: late messages, timers and callbacks are ignored", async () => {
    const { conn, states } = start();
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

  it("nothing fires after a failure either, and close() afterwards stays silent", async () => {
    const { conn, states } = start();
    await flush();
    msg({ type: "error", message: "first" });
    await flush();
    const n = states.length;
    msg({ type: "error", message: "second" });
    h.opts!.onError!({ message: "third" });
    conn.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.length).toBe(n);
    expect(h.socket.close).toHaveBeenCalledTimes(1);
  });

  it("restarting (Apply changes) opens a fresh peer without leaking the old one", async () => {
    const a = start();
    await flush();
    const first = pc();
    a.conn.close();
    start();
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
