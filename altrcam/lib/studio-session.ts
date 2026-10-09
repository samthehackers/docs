/**
 * Browser-only. A live Studio session, kept out of the React component so its timers, connection and billing
 * behaviour can be tested with fakes (tests/unit/studio-session.test.ts).
 *
 * One session = one server-side studio_sessions row (credits are used from its start) + one WebRTC connection +
 * three timers (display tick, stats, heartbeat). The rules this file exists to enforce:
 *  - Whenever the connection fails, the server session is ended and every timer stopped, so a dead connection
 *    stops using credits, and the user is told why. A failure stays on screen until they act.
 *  - Reconnect always ends the failed attempt and starts a NEW server session, billed from its start.
 *  - Nothing started by an old attempt (a late response, a stale callback, a timer) can touch the current one.
 *  - dispose() leaves no timer, listener or connection behind.
 * There is deliberately no automatic retry: every attempt is a new billed session, and until the first real run
 * against the service shows what goes wrong, retrying on its own could silently use credits on attempts that fail
 * the same way every time.
 */
import type { ConnectOptions, ConnState, LucyConnection, LucyFailure, RtcStats } from "@/lib/fal/signaling";
import type { ClientEndReason } from "@/lib/session-end";
import { describeFailure, describeStartFailure, MESSAGES, type Notice } from "@/lib/studio-messages";

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
  return { state: "idle", notice: null, offline: false, remaining: balance, sessionLeft: null, stats: null, liveSince: null };
}

const JSON_HEADERS = { "Content-Type": "application/json" };

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
  let pendingEnd: { id: string; reason: ClientEndReason } | null = null; // an end the server hasn't confirmed yet
  let framed: string | null = null;    // the session whose first transformed frame has rendered
  let liveSent: string | null = null;  // the session whose live time the server has confirmed

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
    set({ stats: null });
  }

  /** Tell the server the session is over. If it can't be reached, remember to try again when the browser is back online. */
  async function endServerSession(id: string, reason: ClientEndReason): Promise<boolean> {
    try {
      const r = await d.fetch("/api/studio/session/end", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: id, reason }) });
      if (r.ok || r.status === 404) { // 404: not ours or already gone, nothing left to close
        if (pendingEnd?.id === id) pendingEnd = null;
        if (r.ok && sid === null) {
          const j = (await r.json().catch(() => null)) as { remaining?: unknown } | null;
          if (typeof j?.remaining === "number") set({ remaining: j.remaining });
        }
        return true;
      }
    } catch { /* network */ }
    pendingEnd = { id, reason };
    return false;
  }

  function startTimers() {
    clearTimers();
    tick = setInterval(() => set({ remaining: Math.max(0, view.remaining - 1), sessionLeft: view.sessionLeft === null ? null : Math.max(0, view.sessionLeft - 1) }), 1000);
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
    if (r.status === 404 || r.status === 409) await stop({ notice: { tone: "info", text: MESSAGES.sessionEnded } });
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
    if (!j.continue) await stop({ notice: { tone: "info", text: j.reason === "credits" ? MESSAGES.outOfCredits : MESSAGES.sessionLimit } });
  }

  /** (Re)open the connection for session `id`, closing any earlier one. False if it failed on the spot (already handled). */
  function open(id: string, i: StartInputs, referenceImageUrl: string | undefined): boolean {
    const prev = conn;
    conn = null;
    const mine = ++attempt;
    prev?.close();
    lastStats = null;
    set({ state: "connecting", notice: null, stats: null });
    const stream = d.getStream();
    if (!stream) { void failAttempt(mine, { code: "setup_error", message: "No live camera track" }); return false; }
    let c: LucyConnection;
    try {
      c = d.connect({
        sessionId: id, stream, inputs: { prompt: i.prompt, enablePromptExpansion: i.expand, referenceImageUrl },
        onRemoteStream: (s) => { if (mine === attempt) d.onRemoteStream(s); },
        onState: (s, detail, failure) => {
          if (mine !== attempt) return; // an attempt we already replaced or tore down
          if (s === "live") set({ state: "live", notice: null });
          else if (s === "connecting") set({ state: "connecting", notice: detail ? { tone: "info", text: detail } : null });
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

  /** The connection failed: stop the timers, end the server session so credits stop being used, tell the user why. */
  async function failAttempt(mine: number, f: LucyFailure) {
    if (mine !== attempt) return;
    const id = sid;
    sid = null;
    teardown();
    const base = describeFailure(f);
    const notice: Notice = { tone: "error", text: base, retryLabel: "Reconnect", hint: MESSAGES.reconnectHint };
    set({ state: "failed", notice });
    if (!id) return;
    const ok = await endServerSession(id, "connection_failed");
    if (view.notice === notice) set({ notice: { ...notice, text: `${base} ${ok ? MESSAGES.sessionClosed : MESSAGES.endUnconfirmed}` } });
  }

  async function stop(why: { notice?: Notice; reason?: ClientEndReason } = {}) {
    run++; // cancels a start still waiting for the server
    activeRun = null;
    const id = sid;
    sid = null;
    teardown();
    set({ state: "idle", notice: why.notice ?? null });
    if (id) {
      const ok = await endServerSession(id, why.reason ?? "user");
      // A Stop the server never heard about leaves the session open until the sweep or the next start closes it: say so.
      if (!ok && !disposed && view.state === "idle" && !view.notice) set({ notice: { tone: "error", text: MESSAGES.endUnconfirmed } });
    }
  }

  async function start(i: StartInputs) {
    if (disposed || activeRun !== null || sid) return; // a start is already running, or a session is open: ignore a double click
    const mine = ++run;
    activeRun = mine;
    const cancelled = () => disposed || mine !== run;
    try {
      teardown(); // nothing from an earlier attempt may still be running
      if (!d.getStream()) { set({ state: "idle", notice: { tone: "error", text: MESSAGES.noCamera } }); return; }
      if (!d.network.online()) { set({ state: "idle", offline: true }); return; } // the offline banner says why; nothing is sent
      set({ state: "connecting", notice: null });

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
      const body = (await res.json().catch(() => null)) as { error?: string; sessionId?: string; remaining?: number; maxSeconds?: number } | null;
      if (!res.ok) {
        if (cancelled()) return;
        const p = describeStartFailure({ status: res.status, error: body?.error });
        set({ state: "idle", ...(p.outOfCredits ? { remaining: 0 } : {}), notice: { tone: "error", text: p.message, ...(p.retry ? { retryLabel: "Try again" } : {}) } });
        return;
      }
      if (!body?.sessionId) {
        if (!cancelled()) set({ state: "idle", notice: { tone: "error", text: MESSAGES.unreadableStart, retryLabel: "Try again" } });
        return;
      }
      if (cancelled()) { void endServerSession(body.sessionId, "user"); return; } // stopped while the server was creating it: don't leave it open
      sid = body.sessionId;
      set({ remaining: body.remaining ?? view.remaining, sessionLeft: body.maxSeconds ?? null, liveSince: null });
      if (open(sid, i, referenceImageUrl)) startTimers(); // a connection that failed on the spot has already ended the session
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
    if (online && pendingEnd) { const p = pendingEnd; void endServerSession(p.id, p.reason); }
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
      const ending = [sid ? { id: sid, reason: "user" as ClientEndReason } : null, pendingEnd].filter((e) => e !== null);
      sid = null;
      pendingEnd = null;
      run++;
      activeRun = null;
      teardown();
      unsubscribeNetwork();
      listeners.clear();
      // Best effort: the page may be going away. A session left open is closed by the server's sweep.
      for (const e of ending) void d.fetch("/api/studio/session/end", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ sessionId: e.id, reason: e.reason }) }).catch(() => {});
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
