/**
 * Browser-only. WebRTC signaling for the Lucy realtime endpoint, isolated in one file.
 *
 * Sequence: ICE servers → SDP offer → SDP answer → trickled ICE candidates → remote track.
 * Messages travel over fal's realtime socket (@fal-ai/client), authenticated
 * with a short-lived token minted through our gated proxy (/api/fal/proxy).
 *
 * Serialization: uses the @fal-ai/client defaults (what fal's documented `fal.realtime.connect(...).send(obj)`
 * usage relies on). Earlier this forced JSON text frames; that was a guess and has been removed.
 *
 * UNVERIFIED: the message `type` names / field names below were written without access to fal's
 * signaling spec (see README_LIMITATIONS.md). If fal's schema differs, only `Outgoing`, `Incoming`
 * and `handleIncoming` need to change.
 */
import { fal } from "@fal-ai/client";
import { FAL_APP, SESSION_HEADER } from "./config";

export interface LucyInputs {
  prompt: string;
  enablePromptExpansion: boolean;
  referenceImageUrl?: string;
}

type Outgoing =
  | { type: "offer"; sdp: string; prompt: string; enable_prompt_expansion: boolean; reference_image_url?: string }
  | { type: "ice_candidate"; candidate: RTCIceCandidateInit };

type Incoming =
  | { type: "ice_servers"; ice_servers: RTCIceServer[] }
  | { type: "answer"; sdp: string }
  | { type: "ice_candidate"; candidate: RTCIceCandidateInit }
  | { type: "error"; message?: string };

export type ConnState = "idle" | "connecting" | "live" | "failed" | "closed";

export interface LucyConnection {
  pc: () => RTCPeerConnection | null;
  close: () => void;
}

export interface ConnectOptions {
  sessionId: string;
  stream: MediaStream;
  inputs: LucyInputs;
  onRemoteStream: (s: MediaStream) => void;
  onState: (s: ConnState, detail?: string) => void;
}

const FALLBACK_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const ICE_WAIT_MS = 3000;
const ANSWER_TIMEOUT_MS = 20000;

export function connectLucy(o: ConnectOptions): LucyConnection {
  fal.config({
    proxyUrl: "/api/fal/proxy",
    requestMiddleware: async (req) => ({ ...req, headers: { ...(req.headers ?? {}), [SESSION_HEADER]: o.sessionId } }),
  });

  let pc: RTCPeerConnection | null = null;
  let closed = false;
  let remoteSet = false;
  const pendingRemote: RTCIceCandidateInit[] = [];
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;

  o.onState("connecting");

  const socket = fal.realtime.connect<Outgoing, Incoming>(FAL_APP, {
    connectionKey: `altrcam-${o.sessionId}-${Math.random().toString(36).slice(2)}`,
    throttleInterval: 0,
    clientOnly: true,
    onResult: (msg) => void handleIncoming(msg as Incoming).catch((e) => fail(e)),
    onError: (e) => fail(e),
  });

  function fail(e: unknown) {
    if (closed) return;
    o.onState("failed", e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
    close();
  }

  async function start(iceServers: RTCIceServer[]) {
    if (started || closed) return;
    started = true;
    clearTimeout(iceTimer);
    const conn = new RTCPeerConnection({ iceServers });
    pc = conn;
    o.stream.getTracks().forEach((t) => conn.addTrack(t, o.stream));
    conn.ontrack = (ev) => { if (ev.streams[0]) o.onRemoteStream(ev.streams[0]); };
    conn.onicecandidate = (ev) => { if (ev.candidate) socket.send({ type: "ice_candidate", candidate: ev.candidate.toJSON() }); };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "connected") { clearTimeout(answerTimer); o.onState("live"); }
      else if (conn.connectionState === "failed") fail(new Error("Connection failed"));
      else if (conn.connectionState === "disconnected") o.onState("connecting", "Reconnecting…");
    };
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    socket.send({
      type: "offer", sdp: offer.sdp ?? "",
      prompt: o.inputs.prompt,
      enable_prompt_expansion: o.inputs.enablePromptExpansion,
      ...(o.inputs.referenceImageUrl ? { reference_image_url: o.inputs.referenceImageUrl } : {}),
    });
    answerTimer = setTimeout(() => fail(new Error("Timed out waiting for the model to answer")), ANSWER_TIMEOUT_MS);
  }

  async function handleIncoming(msg: Incoming) {
    if (closed) return;
    switch (msg.type) {
      case "ice_servers":
        await start(msg.ice_servers?.length ? msg.ice_servers : FALLBACK_ICE);
        break;
      case "answer":
        if (!pc) return;
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        remoteSet = true;
        for (const c of pendingRemote.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        break;
      case "ice_candidate":
        if (!pc || !remoteSet) pendingRemote.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      case "error":
        fail(new Error(msg.message ?? "Model error"));
        break;
    }
  }

  // If the service never announces ICE servers, proceed with a public STUN server.
  const iceTimer = setTimeout(() => void start(FALLBACK_ICE).catch(fail), ICE_WAIT_MS);

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(answerTimer);
    clearTimeout(iceTimer);
    try { pc?.close(); } catch { /* already closed */ }
    try { socket.close(); } catch { /* already closed */ }
    pc = null;
    o.onState("closed");
  }

  return { pc: () => pc, close };
}

export interface RtcStats { fps: number; rttMs: number; jitterMs: number; lossPct: number }

/** FPS / RTT / jitter / loss from RTCPeerConnection.getStats(). */
export async function readStats(pc: RTCPeerConnection): Promise<RtcStats> {
  let fps = 0, rtt = 0, jitter = 0, lost = 0, received = 0;
  (await pc.getStats()).forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "video") {
      fps = r.framesPerSecond ?? fps;
      jitter = (r.jitter ?? 0) * 1000;
      lost = r.packetsLost ?? 0;
      received = r.packetsReceived ?? 0;
    }
    if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated) rtt = (r.currentRoundTripTime ?? 0) * 1000;
  });
  const total = lost + received;
  return { fps: Math.round(fps), rttMs: Math.round(rtt), jitterMs: Math.round(jitter), lossPct: total ? Math.round((lost / total) * 1000) / 10 : 0 };
}
