/**
 * Browser-only. A live Studio session, kept out of the React component so its timers, connection and billing
 * behaviour can be tested with fakes (tests/unit/studio-session.test.ts).
 *
 * One session = one server-side studio_sessions row + one WebRTC connection + three timers (display tick, stats,
 * heartbeat). Credits are used only from the session's first transformed frame: the page reports it (firstFrame →
 * POST /live) and the server bills from its own clock from then; until then nothing is charged and the local
 * countdown does not move. The rules this file exists to enforce:
 *  - Whenever the connection fails, the server session is ended and every timer stopped, so a dead connection
 *    stops using credits, and the user is told why. A failure stays on screen until they act.
 *  - Reconnect always ends the failed attempt and starts a NEW server session, billed from its own first frame.
 *  - Nothing started by an old attempt (a late response, a stale callback, a timer) can touch the current one.
 *  - dispose() leaves no timer, listener or connection behind.
 *  - Go live gives up if no transformed frame has rendered within CONNECT_TIMEOUT_SECONDS (connect_timeout).
 *  - Exactly ONE automatic retry per Go live, and only for an ICE failure before the first frame: that attempt never
 *    went live, so it cost nothing, and the retry is a fresh session. The failed one is ended first (the server records
 *    it as failed_connect, 0 credits). The retry's own failure is shown like any other; it never retries again.
 */
import type { ConnectOptions, ConnState, LucyConnection, LucyFailure, RtcStats } from "@/lib/fal/signaling";
import type { ClientEndReason } from "@/lib/session-end";
import { CONNECT_TIMEOUT_SECONDS } from "@/lib/plans";
import { describeFailure, describeStartFailure, MESSAGES, refundedText, type Notice, type StudioFailure } from "@/lib/studio-messages";

export interface StartInputs {
  prompt: string;
  expand: boolean;
  kind: string;
  referencePath: string | null;
}

export interface SessionView {
  state: ConnState;
  /** Sticky until the user acts: why the last attempt failed, or what just ended the session. */
  notice: Notice | null;
  offline: boolean;
  /** Credits left, counted down locally between server answers. */
  remaining: number;
  sessionLeft: number | null;
  stats: RtcStats | null;
  /** Browser time (ms) at which this session's first transformed frame rendered: credits count from then. Null before. */
  liveSince: number | null;
  /** The connection is recovering (or renegotiating) after the session had gone live. It is still billed: same session. */
  reconnecting: boolean;
  /** The last session, once it is over: how long it was live and, once the server confirms, what it cost. */
  ended: SessionSummary | null;
}

export interface SessionSummary {
  /** Seconds from the first frame to the end, by the browser's clock; null if it never went live. */
  liveSeconds: number | null;
  /** Seconds the server billed (1 credit each), once it has confirmed the end; null until then. */
  billed: number | null;
  /** Credits the server gave back for an early drop. */
  refunded: number;
}

/** The connection state as the Studio shows it: Ready, then Connecting → Live → Reconnecting → Ended. */
export type SessionPhase = "ready" | "connecting" | "live" | "reconnecting" | "ended";
export const PHASE_LABELS: Record<SessionPhase, string> = { ready: "Ready", connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", ended: "Ended" };

/**
 * Live means the transformed video is on screen (and billed); a connection that is up but has shown no frame yet is
 * still Connecting. A failed session is Ended too; the notice says why.
 */
export function sessionPhase(v: SessionView): SessionPhase {
  if (v.state === "connecting") return v.reconnecting ? "reconnecting" : "connecting";
  if (v.state === "live") return v.liveSince === null ? "connecting" : "live";
  if (v.state === "failed" || v.ended) return "ended";
  return "ready";
}

export interface SessionDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  connect: (o: ConnectOptions) => LucyConnection;
  readStats: (pc: RTCPeerConnection) => Promise<RtcStats>;
  /** A fresh read URL for the reference image at this storage path. */
  referenceUrl: (path: string) => Promise<string>;
  /** The camera stream to send, or null when there is no live video track. */
  getStream: () => MediaStream | null;
  /** The transformed video, or null when it is gone. */
  onRemoteStream: (s: MediaStream | null) => void;
  network: Network;
  balance: number;
  heartbeatSeconds: number;
}

export interface Network {
  online: () => boolean;
  /** Call `cb` when the browser goes online or offline. Returns the unsubscribe. */
  subscribe: (cb: () => void) => () => void;
}

export interface StudioSession {
  view: () => SessionView;
  subscribe: (fn: (v: SessionView) => void) => () => void;
  /** Go live: a new server session and a new connection. */
  start: (i: StartInputs) => Promise<void>;
  /** End whatever is open (failed or stuck) and start a new session. */
  reconnect: (i: StartInputs) => Promise<void>;
  /** Re-negotiate the same session with new inputs. */
  applyChanges: (i: StartInputs) => Promise<void>;
  /** The user's Stop, or a system stop with a notice and a reason. */
  stop: (why?: { notice?: Notice; reason?: ClientEndReason }) => Promise<void>;
  /** The camera's video track ended: end the session if one is open. */
  cameraLost: () => Promise<void>;
  /** The output <video> rendered its first transformed frame (lib/first-frame.ts): tell the server, which bills from now. */
  firstFrame: () => void;
  sessionId: () => string | null;
  dispose: () => void;
}

export function initialSessionView(balance: number): SessionView {
  return { state: "idle", notice: null, offline: false, remaining: balance, sessionLeft: null, stats: null, liveSince: null, reconnecting: false, ended: null };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/** The failure code sent with an end call: the connection's own, or the Studio's connect timeout. */
type EndFailure = LucyFailure["code"] | "connect_timeout";
interface EndCall { id: string; reason: ClientEndReason; failure?: EndFailure }
/** What the server confirmed when it closed a session. */
interface Ended { refunded: number; billed: number | null }
const endBody = (e: EndCall) => ({ sessionId: e.id, reason: e.reason, ...(e.failure ? { failure: e.failure } : {}) });

export function createStudioSession(d: SessionDeps): StudioSession {
  let view: SessionView = { ...initialSessionView(d.balance), offline: !d.network.online() };
  const listeners = new Set<(v: SessionView) => void>();
  let disposed = false;
  let sid: string | null = null;
  let conn: LucyConnection | null = null;
  let attempt = 0;                  // bumped whenever a connection is made or torn down; older callbacks compare and drop out
  let run = 0;                      // bumped by stop() and dispose(); a start that sees a newer value was cancelled
  let activeRun: number | null = null; // the start in flight, if any
  let tick: ReturnType<typeof setInterval> | null = null;
  let hb: ReturnType<typeof setInterval> | null = null;
  let statTimer: ReturnType<typeof setInterval> | null = null;
  let lastStats: RtcStats | null = null;
  let pendingEnd: EndCall | null = null; // an end the server hasn't confirmed yet
  let framed: string | null = null;    // the session whose first transformed frame has rendered
  let liveSent: string | null = null;  // the session whose live time the server has confirmed
  let goLiveAt = 0;                    // when this attempt was asked for (Go live, or the automatic retry): the connect timeout runs from here
  let retriesLeft = 0;                 // automatic retries left for the current Go live (one, for an ICE failure before the first frame)
  let lastInputs: StartInputs | null = null;
  let endedId: string | null = null;   // the session `view.ended` describes

  const set = (patch: Partial<SessionView>) => {
    view = { ...view, ...patch };
    if (!disposed) listeners.forEach((fn) => fn(view));
  };

  function clearTimers() {
    for (const t of [tick, hb, statTimer]) if (t) clearInterval(t);
    tick = hb = statTimer = null;
  }

  /** Stop everything local: timers, connection, remote video. Does not touch the server. */
  function teardown() {
    attempt++;
    clearTimers();
    const c = conn;
    conn = null;
    c?.close();
    lastStats = null;
    d.onRemoteStream(null);
    set({ stats: null, reconnecting: false });
  }

  /** Session `id` is over (locally): record how long it was live, for the summary and the Ended state. */
  function markEnded(id: string) {
    endedId = id;
    const liveSeconds = framed === id && view.liveSince !== null ? Math.max(0, Math.floor((Date.now() - view.liveSince) / 1000)) : null;
    set({ ended: { liveSeconds, billed: null, refunded: 0 } });
  }

  /**
   * Tell the server the session is over (with the failure code when a connection failed: an early drop may be refunded).
   * Resolves to what the server confirmed, or null if it can't be reached, in which case the call is remembered and
   * tried again when the browser is back online.
   */
  async function endServerSession(id: string, reason: ClientEndReason, failure?: EndFailure): Promise<Ended | null> {
    try {
      const r = await d.fetch("/api/studio/session/end", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(endBody({ id, reason, failure })) });
      if (r.ok || r.status === 404) { // 404: not ours or already gone, nothing left to close
        if (pendingEnd?.id === id) pendingEnd = null;
        const j = r.ok ? (await r.json().catch(() => null)) as { remaining?: unknown; refunded?: unknown; secondsBilled?: unknown } | null : null;
        if (sid === null && typeof j?.remaining === "number") set({ remaining: j.remaining });
        const out: Ended = { refunded: typeof j?.refunded === "number" && j.refunded > 0 ? j.refunded : 0, billed: typeof j?.secondsBilled === "number" ? j.secondsBilled : null };
        if (endedId === id && view.ended) set({ ended: { ...view.ended, billed: out.billed, refunded: out.refunded } });
        return out;
      }
    } catch { /* network */ }
    pendingEnd = { id, reason, failure };
    return null;
  }

  function startTimers() {
    clearTimers();
    tick = setInterval(() => {
      if (view.liveSince === null) {
        // Credits count from the first transformed frame, as on the server. Until then, give up after the connect timeout.
        if (sid && Date.now() - goLiveAt >= CONNECT_TIMEOUT_SECONDS * 1000) void failAttempt(attempt, { code: "connect_timeout", message: `No transformed frame within ${CONNECT_TIMEOUT_SECONDS} s` });
        return;
      }
      set({ remaining: Math.max(0, view.remaining - 1), sessionLeft: view.sessionLeft === null ? null : Math.max(0, view.sessionLeft - 1) });
    }, 1000);
    statTimer = setInterval(async () => {
      const pc = conn?.pc();
      if (!pc) return;
      try {
        const st = await d.readStats(pc);
        if (conn?.pc() !== pc) return; // torn down or renegotiated while reading
        lastStats = st;
        set({ stats: st });
      } catch { /* ignore */ }
    }, 2000);
    hb = setInterval(() => void heartbeat(), d.heartbeatSeconds * 1000);
  }

  /**
   * Tell the server the first frame rendered (it bills from its own clock from then). A network error is retried with the
   * next heartbeat; a refusal means the session is over on the server, so it is ended here too.
   */
  async function reportLive(id: string) {
    const r = await d.fetch("/api/studio/session/live", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: id }) }).catch(() => null);
    if (id !== sid || !r) return;
    if (r.ok) { liveSent = id; return; }
    if (r.status === 404 || r.status === 409) {
      const j = (await r.json().catch(() => null)) as { reason?: string } | null;
      if (id === sid) await stop({ notice: { tone: "info", text: j?.reason === "failed_connect" ? MESSAGES.neverConnected : MESSAGES.sessionEnded } });
    }
  }

  function firstFrame() {
    const id = sid;
    if (!id || framed === id) return; // no session, or this one already went live (a renegotiated stream is not a new start)
    framed = id;
    set({ liveSince: Date.now() });
    void reportLive(id);
  }

  async function heartbeat() {
    const id = sid;
    if (!id) return;
    if (framed === id && liveSent !== id) { await reportLive(id); if (id !== sid) return; }
    const st = lastStats;
    const r = await d.fetch("/api/studio/session/heartbeat", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: id, stats: st ? { fps: st.fps, rttMs: st.rttMs } : undefined }) }).catch(() => null);
    if (id !== sid) return; // the session changed while we waited
    if (!r) return; // transient network error: the server closes the session itself if the silence persists
    if (!r.ok) { await stop({ notice: { tone: "info", text: MESSAGES.sessionEnded } }); return; }
    const j = (await r.json().catch(() => null)) as { remaining: number; secondsLeftInSession: number; continue: boolean; reason?: string } | null;
    if (!j || id !== sid) return;
    set({ remaining: j.remaining, sessionLeft: j.secondsLeftInSession });
    if (!j.continue) await stop({ notice: { tone: "info", text: j.reason === "credits" ? MESSAGES.outOfCredits : j.reason === "failed_connect" ? MESSAGES.neverConnected : MESSAGES.sessionLimit } });
  }

  /** (Re)open the connection for session `id`, closing any earlier one. False if it failed on the spot (already handled). */
  function open(id: string, i: StartInputs, referenceImageUrl: string | undefined): boolean {
    const prev = conn;
    conn = null;
    const mine = ++attempt;
    prev?.close();
    lastStats = null;
    set({ state: "connecting", notice: null, stats: null, reconnecting: framed === id }); // renegotiating a live session: Reconnecting
    const stream = d.getStream();
    if (!stream) { void failAttempt(mine, { code: "setup_error", message: "No live camera track" }); return false; }
    let c: LucyConnection;
    try {
      c = d.connect({
        sessionId: id, stream, inputs: { prompt: i.prompt, enablePromptExpansion: i.expand, referenceImageUrl },
        onRemoteStream: (s) => { if (mine === attempt) d.onRemoteStream(s); },
        onState: (s, detail, failure) => {
          if (mine !== attempt) return; // an attempt we already replaced or tore down
          if (s === "live") set({ state: "live", notice: null, reconnecting: false });
          else if (s === "connecting") set({ state: "connecting", reconnecting: framed === id, notice: detail ? { tone: "info", text: detail } : null });
          else if (s === "failed") void failAttempt(mine, failure ?? { code: "setup_error", message: detail ?? "Connection failed" });
          // "closed" is only ever the echo of our own close()
        },
      });
    } catch (e) {
      void failAttempt(mine, { code: "setup_error", message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    if (mine !== attempt) { c.close(); return false; } // failed or replaced before connect() returned
    conn = c;
    return true;
  }

  /**
   * The connection failed (or never showed a frame in time): stop the timers, end the server session so credits stop
   * being used, tell the user why. An ICE failure before the first frame is retried once, automatically, on a new session.
   */
  async function failAttempt(mine: number, f: StudioFailure) {
    if (mine !== attempt) return;
    const id = sid;
    sid = null;
    const neverLive = !!id && framed !== id;
    teardown();
    if (id) markEnded(id);

    if (id && neverLive && f.code === "ice_failed" && retriesLeft > 0 && lastInputs) {
      retriesLeft = 0; // one per Go live: the retry's own failure is shown, never retried
      const inputs = lastInputs;
      const myRun = run;
      const notice: Notice = { tone: "info", text: MESSAGES.autoRetry };
      set({ state: "connecting", notice });
      await endServerSession(id, "connection_failed", f.code); // closed as failed_connect, 0 credits
      if (disposed || run !== myRun || sid || activeRun !== null) return; // the user stopped or started something meanwhile
      goLiveAt = Date.now(); // the retry gets its own connect timeout
      await begin(inputs, notice);
      return;
    }

    const base = describeFailure(f);
    const timedOut = f.code === "connect_timeout";
    const notice: Notice = { tone: "error", text: base, retryLabel: timedOut ? "Try again" : "Reconnect", hint: timedOut ? MESSAGES.tryAgainHint : MESSAGES.reconnectHint };
    set({ state: "failed", notice });
    if (!id) return;
    const ended = await endServerSession(id, "connection_failed", f.code);
    if (view.notice === notice) {
      // A session that never showed a frame is never billed (the server closes it with 0), whether or not this end call got through.
      const cost = neverLive ? ` ${MESSAGES.nothingCharged}` : ended?.refunded ? ` ${refundedText(ended.refunded)}` : "";
      set({ notice: { ...notice, text: `${base} ${ended ? MESSAGES.sessionClosed : MESSAGES.endUnconfirmed}${cost}` } });
    }
  }

  async function stop(why: { notice?: Notice; reason?: ClientEndReason } = {}) {
    run++; // cancels a start still waiting for the server
    activeRun = null;
    const id = sid;
    sid = null;
    teardown();
    if (id) markEnded(id);
    set({ state: "idle", notice: why.notice ?? null });
    if (id) {
      const ok = (await endServerSession(id, why.reason ?? "user")) !== null;
      // A Stop the server never heard about leaves the session open until the sweep or the next start closes it: say so.
      if (!ok && !disposed && view.state === "idle" && !view.notice) set({ notice: { tone: "error", text: MESSAGES.endUnconfirmed } });
    }
  }

  /** The user's Go live (or Reconnect / Try again): a new attempt, with its one automatic retry available. */
  async function start(i: StartInputs) {
    if (disposed || activeRun !== null || sid) return; // a start is already running, or a session is open: ignore a double click
    retriesLeft = 1;
    lastInputs = i;
    goLiveAt = Date.now();
    await begin(i);
  }

  /** Start a server session and connect. `keep` is a notice to leave on screen meanwhile (the automatic retry's). */
  async function begin(i: StartInputs, keep: Notice | null = null) {
    if (disposed || activeRun !== null || sid) return;
    const mine = ++run;
    activeRun = mine;
    const cancelled = () => disposed || mine !== run;
    try {
      teardown(); // nothing from an earlier attempt may still be running
      if (!d.getStream()) { set({ state: "idle", notice: { tone: "error", text: MESSAGES.noCamera } }); return; }
      if (!d.network.online()) { set({ state: "idle", offline: true }); return; } // the offline banner says why; nothing is sent
      set({ state: "connecting", notice: keep });

      // Read the reference image before the session exists: failing here costs nothing.
      let referenceImageUrl: string | undefined;
      if (i.referencePath) {
        try { referenceImageUrl = await d.referenceUrl(i.referencePath); }
        catch { if (!cancelled()) set({ state: "idle", notice: { tone: "error", text: MESSAGES.referenceImage, retryLabel: "Try again" } }); return; }
        if (cancelled()) return;
      }

      let res: Response;
      try {
        res = await d.fetch("/api/studio/session/start", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ settings: { prompt: i.prompt, expand: i.expand, kind: i.kind } }) });
      } catch {
        if (!cancelled()) {
          const p = describeStartFailure({ network: true });
          set({ state: "idle", notice: { tone: "error", text: p.message, retryLabel: "Try again" } });
        }
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string; sessionId?: string; remaining?: number; maxSeconds?: number } | null;
      if (!res.ok) {
        if (cancelled()) return;
        const p = describeStartFailure({ status: res.status, error: body?.error, code: body?.code });
        set({ state: "idle", ...(p.outOfCredits ? { remaining: 0 } : {}), notice: { tone: "error", text: p.message, ...(p.retry ? { retryLabel: "Try again" } : {}) } });
        return;
      }
      if (!body?.sessionId) {
        if (!cancelled()) set({ state: "idle", notice: { tone: "error", text: MESSAGES.unreadableStart, retryLabel: "Try again" } });
        return;
      }
      if (cancelled()) { void endServerSession(body.sessionId, "user"); return; } // stopped while the server was creating it: don't leave it open
      sid = body.sessionId;
      endedId = null;
      set({ remaining: body.remaining ?? view.remaining, sessionLeft: body.maxSeconds ?? null, liveSince: null, ended: null });
      if (open(sid, i, referenceImageUrl)) {
        startTimers(); // a connection that failed on the spot has already ended the session
        if (keep) set({ notice: keep }); // open() clears the notice; the retry's stays until something replaces it
      }
    } finally {
      if (activeRun === mine) activeRun = null;
    }
  }

  async function reconnect(i: StartInputs) {
    // Don't wait for the old session's end call: if the network is bad it could take long, and starting the new
    // session closes any session still open on the server anyway.
    if (sid || conn || activeRun !== null) void stop({ reason: "reconnect" });
    await start(i);
  }

  async function applyChanges(i: StartInputs) {
    const id = sid;
    if (!id || view.state !== "live") return;
    let url: string | undefined;
    if (i.referencePath) {
      try { url = await d.referenceUrl(i.referencePath); }
      catch { if (id === sid) set({ notice: { tone: "error", text: MESSAGES.referenceImage } }); return; }
      if (id !== sid) return;
    }
    open(id, i, url); // the model takes its inputs with the offer, so new inputs mean a new negotiation
  }

  function onNetwork() {
    const online = d.network.online();
    set({ offline: !online });
    if (online && pendingEnd) { const p = pendingEnd; void endServerSession(p.id, p.reason, p.failure); }
  }
  const unsubscribeNetwork = d.network.subscribe(onNetwork);

  return {
    view: () => view,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start,
    reconnect,
    applyChanges,
    stop,
    cameraLost: async () => { if (sid || conn || activeRun !== null) await stop({ notice: { tone: "error", text: MESSAGES.cameraLostLive }, reason: "camera_lost" }); },
    firstFrame,
    sessionId: () => sid,
    dispose: () => {
      if (disposed) return;
      disposed = true; // no more notifications from here on
      const ending = [sid ? { id: sid, reason: "user" as ClientEndReason } : null, pendingEnd].filter((e): e is EndCall => e !== null);
      sid = null;
      pendingEnd = null;
      run++;
      activeRun = null;
      teardown();
      unsubscribeNetwork();
      listeners.clear();
      // Best effort: the page may be going away. A session left open is closed by the server's sweep.
      for (const e of ending) void d.fetch("/api/studio/session/end", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(endBody(e)) }).catch(() => {});
    },
  };
}

/** The real browser's online/offline signal. */
export function browserNetwork(w: Pick<Window, "addEventListener" | "removeEventListener"> & { navigator: { onLine: boolean } } = window): Network {
  return {
    online: () => w.navigator.onLine,
    subscribe: (cb) => {
      w.addEventListener("online", cb);
      w.addEventListener("offline", cb);
      return () => { w.removeEventListener("online", cb); w.removeEventListener("offline", cb); };
    },
  };
}
