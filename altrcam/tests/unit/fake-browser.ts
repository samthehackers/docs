/**
 * Fakes of the browser pieces the Studio talks to (RTCPeerConnection, WebSocket, fetch), shared by the
 * signaling tests. They record what they are given and let a test drive the other side by hand.
 * Not a Vitest test file (no `.test.`), so it is only ever imported.
 */
import { vi } from "vitest";
import { decode, encode } from "@msgpack/msgpack";

export class FakePC {
  static all: FakePC[] = [];
  /** When set, the next createOffer() waits for it: lets a test close the connection while negotiating. */
  static holdNextOffer: Promise<void> | null = null;
  config: unknown; tracks: unknown[] = []; closed = false;
  localDescription: unknown = null; remoteDescription: unknown = null; candidates: unknown[] = [];
  connectionState = "new";
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ontrack: ((e: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(config: unknown) { this.config = config; FakePC.all.push(this); }
  addTrack(t: unknown) { this.tracks.push(t); }
  async createOffer() {
    const gate = FakePC.holdNextOffer;
    FakePC.holdNextOffer = null;
    if (gate) await gate;
    return { type: "offer", sdp: "offer-sdp" };
  }
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
  /** Fire a local ICE candidate the way the browser would. */
  candidate(name: string) { this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: name }) } }); }
}

/**
 * A WebSocket that stays CONNECTING until the test calls open(), like a handshake in flight.
 * close() mimics browsers: a close without a status code reports 1005, which the fal client treats as an error.
 */
export class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = 0; closeCalls = 0;
  sent: (Uint8Array | string)[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(d: Uint8Array | string) { this.sent.push(d); }
  close() {
    this.closeCalls++;
    if (this.readyState >= 2) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1005, reason: "" }));
  }
  // ---- the test plays the network and the server ----
  open() { this.readyState = 1; this.onopen?.({}); }
  /** A frame from the server: msgpack like the client's default, or JSON text. */
  receive(msg: unknown, as: "msgpack" | "json" = "msgpack") { this.onmessage?.({ data: as === "json" ? JSON.stringify(msg) : encode(msg) }); }
  serverClose(code: number, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
  /** What we sent, decoded. */
  frames(): unknown[] { return this.sent.map((d) => (typeof d === "string" ? JSON.parse(d) : decode(d))); }
}

export const tokenOk = (token = "tok-1") => new Response(JSON.stringify(token), { status: 200, headers: { "content-type": "application/json" } });
export const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Install window/WebSocket/RTCPeerConnection/fetch fakes. Pair with `vi.unstubAllGlobals()` in afterEach. */
export function installFakeBrowser(fetchImpl: (url: string, init?: RequestInit) => Response | Promise<Response> = () => tokenOk()) {
  FakePC.all = []; FakePC.holdNextOffer = null; FakeWebSocket.all = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => fetchImpl(url, init));
  vi.stubGlobal("window", { document: {} }); // the fal client only opens sockets when it believes it is in a browser
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("RTCPeerConnection", FakePC);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

/** Let promise chains and zero-delay timers run. */
export const settle = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };
