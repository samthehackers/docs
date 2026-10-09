/**
 * lib/fal/signaling.ts driven through the REAL pinned @fal-ai/client (node_modules/@fal-ai/client/src/realtime.js).
 * Only the browser edge is faked: WebSocket, fetch and RTCPeerConnection (tests/unit/fake-browser.ts), so the
 * client's own state machine, token handling, queueing and msgpack encoding all run for real.
 *
 * Why this file exists: signaling.test.ts replaces the whole fal client with a mock whose socket is always open and
 * delivers messages on demand. That cannot show how the real client orders messages. This file does.
 *
 * What it proves: how OUR code behaves against this client version's socket/queue/token rules (offer first, ordered
 * outbox, token failures reported, no stray sends after close).
 * What it does NOT prove: that fal's service understands our message names or shapes, accepts the token request our
 * proxy forwards, or behaves like these fakes. See README_LIMITATIONS.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fal } from "@fal-ai/client";
import { connectLucy, type ConnState, type LucyFailure } from "@/lib/fal/signaling";
import { FakePC, FakeWebSocket, installFakeBrowser, jsonResponse, settle, tokenOk } from "./fake-browser";

const stream = { getTracks: () => [{ id: "cam-track" }] } as unknown as MediaStream;
const APP = "decart/lucy-2-5/realtime";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("the pinned @fal-ai/client (the facts our signaling is built around)", () => {
  const connect = (extra: Record<string, unknown> = {}) => {
    const results: unknown[] = []; const errors: unknown[] = [];
    const socket = fal.realtime.connect<{ n: number }, unknown>(APP, {
      connectionKey: `facts-${Math.random()}`, throttleInterval: 0, clientOnly: true,
      tokenProvider: async () => "tok", onResult: (m) => results.push(m), onError: (e) => errors.push(e), ...extra,
    });
    return { socket, results, errors };
  };

  it("opens nothing until the first send(): no token request, no socket, so no server message can come first", async () => {
    const { fetchMock } = installFakeBrowser();
    const { socket } = connect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    socket.send({ n: 1 });
    await settle();
    expect(FakeWebSocket.all).toHaveLength(1);
    expect(FakeWebSocket.all[0].url).toContain(`wss://fal.run/${APP}`);
    expect(FakeWebSocket.all[0].url).toContain("fal_jwt_token=tok");
  });

  it("keeps a single pending message until the socket is open: a later send() replaces an earlier one", async () => {
    installFakeBrowser();
    const { socket } = connect();
    socket.send({ n: 1 }); socket.send({ n: 2 }); socket.send({ n: 3 });
    await settle();
    const ws = FakeWebSocket.all[0];
    ws.open();
    expect(ws.frames()).toEqual([{ n: 3 }]); // 1 and 2 are gone
  });

  it("sends in order, immediately, once the socket is open", async () => {
    installFakeBrowser();
    const { socket } = connect();
    socket.send({ n: 1 });
    await settle();
    const ws = FakeWebSocket.all[0];
    ws.open();
    socket.send({ n: 2 }); socket.send({ n: 3 });
    expect(ws.frames()).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("with its DEFAULT token provider a refused token is swallowed: onError is never called, so a caller must supply its own tokenProvider to hear about it", async () => {
    installFakeBrowser(() => jsonResponse(403, { error: "No active studio session" }));
    fal.config({ proxyUrl: "/api/fal/proxy" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { socket, errors } = connect({ tokenProvider: undefined });
    socket.send({ n: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(errors).toEqual([]);
    expect(FakeWebSocket.all).toHaveLength(0);
    warn.mockRestore();
    socket.close();
  });

  it("with its DEFAULT token provider it arms a token-refresh timer that close() leaves running when the socket never opened; with a provider and no expiry it arms none (why we pass our own)", async () => {
    installFakeBrowser();
    fal.config({ proxyUrl: "/api/fal/proxy" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dflt = connect({ tokenProvider: undefined });
    dflt.socket.send({ n: 1 });
    await settle();
    expect(FakeWebSocket.all).toHaveLength(1); // token minted, socket created, still handshaking
    dflt.socket.close();
    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the refresh timer, still armed after close
    warn.mockRestore();
    vi.clearAllTimers();

    const own = connect();
    own.socket.send({ n: 1 });
    await settle();
    own.socket.close();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() while the WebSocket handshake is still in flight does not close that socket (known limit of this client version)", async () => {
    installFakeBrowser();
    const { socket } = connect();
    socket.send({ n: 1 });
    await settle();
    const ws = FakeWebSocket.all[0]; // created, still CONNECTING
    socket.close();
    await settle();
    expect(ws.closeCalls).toBe(0); // the client only closes a socket it has seen open
    ws.open(); // it opens anyway, nobody owns it any more
    expect(ws.readyState).toBe(1);
  });
});

describe("connectLucy against the real client", () => {
  function begin(extra: { referenceImageUrl?: string } = {}) {
    const states: [ConnState, string | undefined, LucyFailure | undefined][] = [];
    const conn = connectLucy({
      sessionId: "sess-1", stream, inputs: { prompt: "an astronaut", enablePromptExpansion: true, ...extra },
      onRemoteStream: () => {}, onState: (s, d, f) => states.push([s, d, f as LucyFailure | undefined]),
    });
    const failure = () => states.find(([s]) => s === "failed")?.[2];
    return { conn, states, failure, last: () => states[states.length - 1]?.[0] };
  }
  const ws = () => FakeWebSocket.all[0];
  const types = () => ws().frames().map((f) => (f as { type: string }).type);

  it("sends the offer on its own: the socket is opened by our first send, with no server message and no timer needed", async () => {
    const { fetchMock } = installFakeBrowser();
    begin();
    await settle(); // microtasks only: no timer is advanced
    expect(fetchMock).toHaveBeenCalledTimes(1); // the token request
    expect(FakeWebSocket.all).toHaveLength(1);
    ws().open();
    expect(ws().frames()).toEqual([{ type: "offer", sdp: "offer-sdp", prompt: "an astronaut", enable_prompt_expansion: true }]);
  });

  it("does not let ICE candidates generated while the socket is still opening replace the offer; they follow it, in order, after the first reply", async () => {
    installFakeBrowser();
    begin();
    await vi.advanceTimersByTimeAsync(3100); // whatever happens in the first seconds
    FakePC.all[0].candidate("c1");
    FakePC.all[0].candidate("c2");
    ws().open();
    expect(types()).toEqual(["offer"]); // candidates held back, offer intact
    ws().receive({ type: "answer", sdp: "answer-sdp" });
    await settle();
    expect(ws().frames()).toEqual([
      { type: "offer", sdp: "offer-sdp", prompt: "an astronaut", enable_prompt_expansion: true },
      { type: "ice_candidate", candidate: { candidate: "c1" } },
      { type: "ice_candidate", candidate: { candidate: "c2" } },
    ]);
  });

  it("releases held messages on the server's first reply whatever its type is, and sends later ones straight away", async () => {
    installFakeBrowser();
    begin();
    await settle();
    FakePC.all[0].candidate("early");
    ws().open();
    expect(types()).toEqual(["offer"]);
    ws().receive({ type: "something_we_have_never_heard_of" }, "json"); // names are unverified: any reply counts
    await settle();
    expect(types()).toEqual(["offer", "ice_candidate"]);
    FakePC.all[0].candidate("late");
    expect(ws().frames().at(-1)).toEqual({ type: "ice_candidate", candidate: { candidate: "late" } });
  });

  it("nothing is sent after close() even if the browser was still negotiating: no socket is opened", async () => {
    const { fetchMock } = installFakeBrowser();
    let release!: () => void;
    FakePC.holdNextOffer = new Promise<void>((r) => { release = r; });
    const { conn } = begin();
    await settle();
    conn.close();
    release();
    await settle();
    expect(FakeWebSocket.all).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing before the socket opens leaves no timer behind and never asks for a second token", async () => {
    const { fetchMock } = installFakeBrowser();
    const { conn } = begin();
    await settle();
    conn.close();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("when the token request fails (the fal client would swallow this, so we report it ourselves)", () => {
    it.each([
      [401, "token_refused"], [403, "token_refused"], [429, "token_refused"], [400, "token_refused"],
      [500, "token_unreachable"], [503, "token_unreachable"],
    ])("HTTP %i is reported as %s with its status, at once and not after the 20 s answer timeout", async (status, code) => {
      installFakeBrowser(() => jsonResponse(status, { error: "nope" }));
      const { failure, last, conn } = begin();
      await settle(); // no timers advanced
      expect(last()).toBe("failed");
      expect(failure()).toMatchObject({ code, ...(code === "token_refused" ? { status } : {}) });
      expect(failure()?.message).toContain(String(status));
      expect(FakeWebSocket.all).toHaveLength(0);
      expect(FakePC.all[0].closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      conn.close();
      expect(last()).toBe("failed"); // stays failed: no "closed" after it
    });

    it("a network error is reported as token_unreachable", async () => {
      installFakeBrowser(() => { throw new TypeError("Failed to fetch"); });
      const { failure, last } = begin();
      await settle();
      expect(last()).toBe("failed");
      expect(failure()).toMatchObject({ code: "token_unreachable" });
    });

    it("an unreadable token response is reported as token_unreachable", async () => {
      installFakeBrowser(() => new Response("", { status: 200 }));
      const { failure } = begin();
      await settle();
      expect(failure()).toMatchObject({ code: "token_unreachable" });
    });

    it("sends the request our proxy guard expects: POST /api/fal/proxy, target rest.fal.ai/tokens/, one allowed app, the session header", async () => {
      const { fetchMock } = installFakeBrowser();
      begin();
      await settle();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/fal/proxy");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "x-fal-target-url": "https://rest.fal.ai/tokens/", "x-altrcam-session": "sess-1" });
      const body = JSON.parse(String(init?.body));
      expect(body.allowed_apps).toEqual(["lucy-2-5"]);
      expect(body.token_expiration).toBeLessThanOrEqual(300);
    });

    it.each([
      ["a JSON string", () => tokenOk("jwt-a"), "jwt-a"],
      ["plain text", () => new Response("jwt-b", { status: 200 }), "jwt-b"],
      ["an older proxy's { detail } wrapper", () => jsonResponse(200, { detail: "jwt-c" }), "jwt-c"],
    ])("accepts the token as %s", async (_n, make, token) => {
      installFakeBrowser(make);
      begin();
      await settle();
      expect(ws().url).toContain(`fal_jwt_token=${token}`);
    });
  });

  describe("socket failures", () => {
    it("a socket error is reported as socket_error and stays failed", async () => {
      installFakeBrowser();
      const { failure, last } = begin();
      await settle();
      ws().serverClose(1006, "gone");
      await settle();
      expect(failure()).toMatchObject({ code: "socket_error", status: 1006 });
      expect(last()).toBe("failed");
    });

    it("our own close() is not mistaken for a failure when the browser reports it as code 1005", async () => {
      installFakeBrowser();
      const { conn, states } = begin();
      await settle();
      ws().open();
      conn.close();
      await settle();
      expect(states.map(([s]) => s)).toEqual(["connecting", "closed"]);
    });
  });
});
