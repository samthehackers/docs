/**
 * connectLucy's optional `onTrace` observer (used by /admin/diagnostics). It must only observe: the same scripted
 * attempt sends the same frames and reports the same states with no observer, a recording observer, or one that throws.
 * It must never be handed the token, the SDP, the prompt or message values. fal is faked here (see signaling.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePC, jsonResponse, tokenOk } from "./fake-browser";

const h = vi.hoisted(() => ({
  socket: { send: vi.fn(), close: vi.fn() },
  opts: null as null | { onResult: (m: unknown) => void; onError?: (e: unknown) => void; tokenProvider: () => Promise<string> },
}));
vi.mock("@fal-ai/client", () => ({ fal: { realtime: { connect: vi.fn((_app: string, opts: typeof h.opts) => { h.opts = opts; return h.socket; }) } } }));

import { connectLucy, describeMessage, type ConnState, type TraceEvent } from "@/lib/fal/signaling";

const flush = () => vi.advanceTimersByTimeAsync(0);
const stream = { getTracks: () => [{ id: "cam-track" }] } as unknown as MediaStream;
const pc = () => FakePC.all[FakePC.all.length - 1];
const SECRET_PROMPT = "PROMPT-SECRET", SECRET_SDP = "SDP-SECRET", TOKEN = "TOKEN-SECRET";

type Trace = [TraceEvent, string | undefined][];
async function scripted(onTrace?: (e: TraceEvent, d?: string) => void, fetchImpl: () => Response = () => tokenOk(TOKEN)) {
  FakePC.all = []; h.socket.send.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => fetchImpl()));
  const states: ConnState[] = [];
  const conn = connectLucy({ sessionId: "s", stream, inputs: { prompt: SECRET_PROMPT, enablePromptExpansion: true }, onRemoteStream: () => {}, onState: (s) => states.push(s), onTrace });
  await flush(); // the offer is made and sent first; the real client only asks for a token on that first send
  const token = await h.opts!.tokenProvider().catch(() => null);
  await flush();
  pc().candidate("cand-1"); // queued until the service replies
  h.opts!.onResult({ type: "answer", sdp: SECRET_SDP });
  await flush();
  h.opts!.onResult({ type: "ice_candidate", candidate: { candidate: "remote-1" } });
  h.opts!.onResult({ sdp: SECRET_SDP, weird: { nested: 1 } }); // an unknown shape: reported by its keys only
  await flush();
  pc().ontrack?.({ streams: [{ id: "remote" }] });
  pc().setState("connected");
  conn.close();
  return { states, sent: h.socket.send.mock.calls.map((c) => c[0]), token };
}

beforeEach(() => { vi.useFakeTimers(); (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePC; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("onTrace", () => {
  it("reports the attempt's milestones in order, with only names, types, keys and counts", async () => {
    const trace: Trace = [];
    const r = await scripted((e, d) => trace.push([e, d]));
    expect(r.token).toBe(TOKEN);
    expect(trace).toEqual([
      ["offer_created", undefined], ["offer_sent", undefined],
      ["token_requested", undefined], ["token_received", undefined],
      ["local_candidate", undefined],
      ["server_message", "type=answer"], ["outbox_flushed", "1"], ["answer_applied", undefined],
      ["server_message", "type=ice_candidate"], ["remote_candidate", undefined],
      ["server_message", "keys=sdp,weird"],
      ["remote_track", undefined],
    ]);
    const text = JSON.stringify(trace);
    for (const secret of [SECRET_PROMPT, SECRET_SDP, TOKEN, "cand-1", "remote-1"]) expect(text).not.toContain(secret);
  });

  it("changes nothing: the same frames go out and the same states are reported with no observer or a throwing one", async () => {
    const plain = await scripted(undefined);
    const recorded = await scripted(() => {});
    const throwing = await scripted(() => { throw new Error("observer bug"); });
    expect(recorded).toEqual(plain);
    expect(throwing).toEqual(plain);
    expect(plain.states).toEqual(["connecting", "live", "closed"]);
    expect(plain.sent.map((m: { type?: string }) => m.type)).toEqual(["offer", "ice_candidate"]);
  });

  it("reports a refused token, and the failure is the same as without an observer", async () => {
    const trace: Trace = [];
    const refused = () => jsonResponse(403, { error: "No active studio session" });
    const a = await scripted((e, d) => trace.push([e, d]), refused);
    const b = await scripted(undefined, refused);
    expect(trace).toEqual([["offer_created", undefined], ["offer_sent", undefined], ["token_requested", undefined], ["token_failed", "Token request refused: HTTP 403 (No active studio session)"]]);
    expect(a).toEqual(b);
    expect(a.states).toEqual(["connecting", "failed"]);
  });
});

describe("describeMessage", () => {
  it("never includes a value", () => {
    expect(describeMessage({ type: "error", message: "secret detail" })).toBe("type=error");
    expect(describeMessage({ sdp: "v=0 secret", a: 1 })).toBe("keys=sdp,a");
    expect(describeMessage(["x"])).toBe("array");
    expect(describeMessage("text frame")).toBe("string");
    expect(describeMessage(null)).toBe("object");
  });
});
