/**
 * Browser-only. WebRTC signaling for the Lucy realtime endpoint, isolated in one file.
 *
 * Sequence: SDP offer → SDP answer → trickled ICE candidates → remote track. Messages travel over fal's realtime
 * socket (@fal-ai/client), authenticated with a short-lived token minted through our gated proxy (/api/fal/proxy).
 *
 * MESSAGE ORDER. Written against the real pinned @fal-ai/client (src/realtime.js; tests/unit/signaling-real-client.test.ts
 * drives that client with only the WebSocket, fetch and RTCPeerConnection faked). Two properties of that client
 * decide the design:
 *   1. It opens nothing until the first send(): no token request, no socket. So no server message can arrive first,
 *      and waiting for one before sending can never succeed. We send the OFFER FIRST and never wait for the server.
 *   2. Until the socket is open it keeps ONE pending message, and a later send() replaces it (trickled ICE candidates
 *      replaced the offer). So after the offer we hold every outgoing message in our own ordered outbox and flush it,
 *      in order, once the server's first reply has arrived (a reply can only arrive once the socket is open). The
 *      reply may be of any type: we only use its arrival.
 * The fal client also swallows a failed token request (it goes quiet instead of calling onError), so we supply our
 * own tokenProvider and report that failure ourselves, with the HTTP status.
 *
 * Serialization: uses the @fal-ai/client defaults (what fal's documented `fal.realtime.connect(...).send(obj)`
 * usage relies on).
 *
 * UNVERIFIED: the message `type` names / field names below were written without access to fal's signaling spec
 * (see README_LIMITATIONS.md). If fal's schema differs, `Outgoing`, `Incoming` and `handleIncoming` change; the
 * ordering above does not depend on any name. Nothing here has been run against the live service.
 */
import { fal } from "@fal-ai/client";
import { FAL_APP, FAL_APP_ALIAS, SESSION_HEADER } from "./config";

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

/** Why an attempt failed. The Studio maps these to plain-language text (lib/studio-messages.ts). */
export type FailureCode =
  | "token_refused"     // our proxy (or fal behind it) answered the connection-token request with an error status
  | "token_unreachable" // no usable answer to the token request: network down, server error, unreadable body
  | "socket_error"      // the realtime socket errored or closed abnormally
  | "model_error"       // the service sent an `error` message
  | "bad_answer"        // the service's answer could not be applied by the browser
  | "answer_timeout"    // no answer within ANSWER_TIMEOUT_MS
  | "ice_failed"        // the browser's WebRTC connection failed
  | "connection_lost"   // the connection dropped and did not recover within DISCONNECT_GRACE_MS
  | "setup_error";      // the browser could not build or send the offer

export interface LucyFailure {
  code: FailureCode;
  /** Technical text for diagnostics. Not meant to be shown as the headline. */
  message: string;
  /** HTTP status (token request) or WebSocket close code (socket error), when there is one. */
  status?: number;
}

export interface LucyConnection {
  pc: () => RTCPeerConnection | null;
  close: () => void;
}

export interface ConnectOptions {
  sessionId: string;
  stream: MediaStream;
  inputs: LucyInputs;
  onRemoteStream: (s: MediaStream) => void;
  /**
   * "failed" is final for this connection and is NOT followed by "closed": the resources are already released.
   * "closed" is only reported for a close() the caller asked for.
   */
  onState: (s: ConnState, detail?: string, failure?: LucyFailure) => void;
  /**
   * Optional observer, used by the admin diagnostics check (/admin/diagnostics): named milestones of this attempt, in
   * order. It only observes. Whatever it does, even throwing, changes nothing about the connection. It is never given the
   * token, the SDP, the prompt or any message content: only event names, message types or keys, and counts.
   */
  onTrace?: (event: TraceEvent, detail?: string) => void;
}

/** What `onTrace` reports. `server_message` carries the incoming message's `type` (or, without one, its keys). */
export type TraceEvent =
  | "token_requested" | "token_received" | "token_failed"
  | "offer_created" | "offer_sent" | "server_message" | "outbox_flushed"
  | "answer_applied" | "local_candidate" | "remote_candidate" | "remote_track";

/** A message's shape for diagnostics: its `type`, or its top-level keys. Never a value. */
export function describeMessage(m: unknown): string {
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const t = (m as { type?: unknown }).type;
    if (typeof t === "string") return `type=${t.slice(0, 40)}`;
    return `keys=${Object.keys(m).slice(0, 8).map((k) => k.slice(0, 30)).join(",")}`;
  }
  return Array.isArray(m) ? "array" : typeof m;
}

/** The offer is made before the service can say anything, so it uses a public STUN server; ice_servers messages are not used. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const ANSWER_TIMEOUT_MS = 20000;
/** How long the browser may stay "disconnected" before we give up on it (it usually recovers within seconds, or goes "failed"). */
const DISCONNECT_GRACE_MS = 15000;
/** After the answer is applied, how long ICE gets to connect before the attempt is given up. */
const ICE_CONNECT_TIMEOUT_MS = 30000;
const TOKEN_PROXY_URL = "/api/fal/proxy";
const TOKEN_TARGET_URL = "https://rest.fal.ai/tokens/";
/** Same lifetime the fal client asks for by default. The proxy refuses more than 300. */
const TOKEN_EXPIRATION_SECONDS = 120;

class TokenError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** Mint a realtime token through our proxy, the request the fal client would make itself, but with failures we can see. */
async function requestToken(sessionId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(TOKEN_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-fal-target-url": TOKEN_TARGET_URL, [SESSION_HEADER]: sessionId },
      body: JSON.stringify({ allowed_apps: [FAL_APP_ALIAS], token_expiration: TOKEN_EXPIRATION_SECONDS }),
    });
  } catch (e) {
    throw new TokenError(`Token request failed: ${e instanceof Error ? e.message : "network error"}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let why = "";
    try { why = (JSON.parse(text) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
    throw new TokenError(`Token request refused: HTTP ${res.status}${why ? ` (${why})` : ""}`, res.status);
  }
  // fal answers with a JSON string; plain text and an older proxy's { detail } wrapper are accepted too.
  let token: unknown = text.trim();
  try { token = JSON.parse(text); } catch { /* plain text */ }
  if (token && typeof token === "object") token = (token as { detail?: unknown }).detail;
  if (typeof token !== "string" || !token) throw new TokenError("Token response was empty or unreadable");
  return token;
}

function tokenFailure(e: unknown): LucyFailure {
  const message = e instanceof Error ? e.message : String(e);
  const status = e instanceof TokenError ? e.status : undefined;
  // A server-side error (5xx) or no answer at all is "can't reach"; a 4xx is the server saying no.
  return status !== undefined && status < 500 ? { code: "token_refused", message, status } : { code: "token_unreachable", message, ...(status !== undefined ? { status } : {}) };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));

export function connectLucy(o: ConnectOptions): LucyConnection {
  let pc: RTCPeerConnection | null = null;
  let closed = false;
  let remoteSet = false;
  const pendingRemote: RTCIceCandidateInit[] = [];
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  let iceTimer: ReturnType<typeof setTimeout> | undefined;
  // Outgoing order: the offer, then everything in `outbox`, flushed once the offer is out AND the server has replied.
  const outbox: Outgoing[] = [];
  let offerSent = false;
  let replied = false;

  const trace = (event: TraceEvent, detail?: string) => { try { o.onTrace?.(event, detail); } catch { /* an observer cannot break the connection */ } };

  o.onState("connecting");

  const socket = fal.realtime.connect<Outgoing, Incoming>(FAL_APP, {
    connectionKey: `altrcam-${o.sessionId}-${Math.random().toString(36).slice(2)}`,
    throttleInterval: 0,
    clientOnly: true,
    // No tokenExpirationSeconds: the client then schedules no token-refresh timer (it never clears one when the socket
    // closes before it opens), and an open socket does not need a fresh token.
    tokenProvider: async () => {
      trace("token_requested");
      try {
        const token = await requestToken(o.sessionId);
        trace("token_received");
        return token;
      } catch (e) { trace("token_failed", errorText(e)); fail(tokenFailure(e)); throw e; }
    },
    onResult: (msg) => {
      if (closed) return;
      trace("server_message", describeMessage(msg));
      replied = true;
      flush();
      void handleIncoming(msg as Incoming).catch((e) => fail({ code: "setup_error", message: errorText(e) }));
    },
    onError: (e) => fail({ code: "socket_error", message: errorText(e), status: typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : undefined }),
  });

  /** Final for this connection: release everything, then report. No "closed" follows. */
  function fail(f: LucyFailure) {
    if (closed) return;
    release();
    o.onState("failed", f.message, f);
  }

  function release() {
    closed = true;
    clearTimeout(answerTimer);
    clearTimeout(lostTimer);
    clearTimeout(iceTimer);
    outbox.length = 0;
    if (pc) {
      pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; // nothing may call back into us after this
      try { pc.close(); } catch { /* already closed */ }
    }
    // The fal client keeps ONE pending message for a socket that is still opening and sends it when it opens, and it cannot
    // close a socket it has not seen open. So if the offer is still the pending message (no reply yet), replace it with an
    // empty one: otherwise the orphan socket delivers our offer (prompt and SDP) to a session that no longer exists.
    if (offerSent && !replied) { try { socket.send({} as Outgoing); } catch { /* already closed */ } }
    try { socket.close(); } catch { /* already closed */ }
    pc = null;
  }

  function sendNow(m: Outgoing) {
    if (closed) return; // a send after close would make the fal client open a brand-new socket
    try { socket.send(m); } catch (e) { fail({ code: "setup_error", message: `Could not send to the service: ${errorText(e)}` }); }
  }
  const enqueue = (m: Outgoing) => { if (offerSent && replied) sendNow(m); else outbox.push(m); };
  function flush() {
    if (!offerSent || !replied || !outbox.length) return;
    const queued = outbox.splice(0);
    for (const m of queued) sendNow(m);
    trace("outbox_flushed", String(queued.length));
  }

  async function start() {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc = conn;
    o.stream.getTracks().forEach((t) => conn.addTrack(t, o.stream));
    conn.ontrack = (ev) => { if (ev.streams[0]) { trace("remote_track"); o.onRemoteStream(ev.streams[0]); } };
    conn.onicecandidate = (ev) => { if (ev.candidate) { trace("local_candidate", ev.candidate.type ?? undefined); enqueue({ type: "ice_candidate", candidate: ev.candidate.toJSON() }); } };
    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "connected") { clearTimeout(answerTimer); clearTimeout(iceTimer); clearTimeout(lostTimer); o.onState("live"); }
      else if (conn.connectionState === "failed") fail({ code: "ice_failed", message: "Connection failed" });
      else if (conn.connectionState === "disconnected") {
        o.onState("connecting", "Reconnecting…");
        clearTimeout(lostTimer);
        lostTimer = setTimeout(() => fail({ code: "connection_lost", message: "Disconnected and did not recover" }), DISCONNECT_GRACE_MS);
      }
    };
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    if (closed) return; // closed while the browser was negotiating
    trace("offer_created");
    sendNow({
      type: "offer", sdp: offer.sdp ?? "",
      prompt: o.inputs.prompt,
      enable_prompt_expansion: o.inputs.enablePromptExpansion,
      ...(o.inputs.referenceImageUrl ? { reference_image_url: o.inputs.referenceImageUrl } : {}),
    });
    if (!closed) trace("offer_sent");
    offerSent = true;
    flush();
    answerTimer = setTimeout(() => fail({ code: "answer_timeout", message: "Timed out waiting for the model to answer" }), ANSWER_TIMEOUT_MS);
  }

  const notConnected = () => !!pc && pc.connectionState !== "connected";

  async function handleIncoming(msg: Incoming) {
    if (closed) return;
    switch (msg.type) {
      case "ice_servers":
        break; // the offer was made before the service could say anything, so these cannot be used
      case "answer":
        if (!pc) return;
        try { await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }); } catch (e) { fail({ code: "bad_answer", message: `Could not apply the answer: ${errorText(e)}` }); return; }
        if (closed) return;
        trace("answer_applied");
        // The service answered, so "no answer" is no longer the failure to report. If ICE then never connects (NAT, firewall,
        // VPN, no TURN) say so, instead of blaming the service for silence.
        clearTimeout(answerTimer);
        if (notConnected()) iceTimer = setTimeout(() => fail({ code: "ice_failed", message: "The connection was not established within 30 seconds of the answer" }), ICE_CONNECT_TIMEOUT_MS);
        remoteSet = true;
        for (const c of pendingRemote.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        break;
      case "ice_candidate":
        trace("remote_candidate");
        if (!pc || !remoteSet) pendingRemote.push(msg.candidate);
        else await pc.addIceCandidate(msg.candidate).catch(() => {});
        break;
      case "error":
        fail({ code: "model_error", message: msg.message ?? "Model error" });
        break;
    }
  }

  void start().catch((e) => fail({ code: "setup_error", message: `Could not start the connection: ${errorText(e)}` }));

  function close() {
    if (closed) return;
    release();
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
