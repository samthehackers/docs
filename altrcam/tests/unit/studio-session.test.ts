/**
 * The Studio's session controller (lib/studio-session.ts) with the server, the connection and the network faked.
 * This is where the billing and cleanup rules live: a failed connection must end the server session and stop every
 * timer, the reason must stay visible, Reconnect must start a fresh session, and nothing from an old attempt may
 * touch a new one.
 *
 * What this does NOT prove: that the real routes, the real fal service or a real browser behave like these fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserNetwork, createStudioSession, type SessionDeps, type SessionView, type StartInputs } from "@/lib/studio-session";
import type { ConnectOptions, ConnState, LucyConnection, LucyFailure } from "@/lib/fal/signaling";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Body { sessionId?: string; reason?: string; stats?: unknown; settings?: unknown }
type Route = (body: Body) => Response | Promise<Response>;

class FakeConn implements LucyConnection {
  closed = 0;
  readonly fakePc = { id: "pc" } as unknown as RTCPeerConnection;
  constructor(readonly opts: ConnectOptions) {}
  pc() { return this.fakePc; }
  close() { this.closed++; }
  emit(s: ConnState, detail?: string, failure?: LucyFailure) { this.opts.onState(s, detail, failure); }
}

const INPUTS: StartInputs = { prompt: "an astronaut", expand: true, kind: "prompt", referencePath: null };
const TIMEOUT: LucyFailure = { code: "answer_timeout", message: "Timed out waiting for the model to answer" };
const START = "/api/studio/session/start", BEAT = "/api/studio/session/heartbeat", END = "/api/studio/session/end";

function setup(over: Partial<SessionDeps> & { routes?: Record<string, Route> } = {}) {
  let online = true;
  const netCbs = new Set<() => void>();
  let n = 0;
  const routes: Record<string, Route> = {
    [START]: () => json(200, { sessionId: `s${++n}`, maxSeconds: 120, remaining: 300 }),
    [BEAT]: () => json(200, { remaining: 290, continue: true, secondsLeftInSession: 110 }),
    [END]: () => json(200, { remaining: 280, secondsBilled: 20 }),
    ...over.routes,
  };
  const calls: { url: string; body: Body }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return routes[url](body);
  });
  const conns: FakeConn[] = [];
  const connect = vi.fn((o: ConnectOptions) => { const c = new FakeConn(o); conns.push(c); o.onState("connecting"); return c; });
  const remote: (MediaStream | null)[] = [];
  const stream = { id: "cam" } as unknown as MediaStream;
  const deps: SessionDeps = {
    fetch: fetchFn, connect,
    readStats: vi.fn(async () => ({ fps: 24, rttMs: 40, jitterMs: 2, lossPct: 0 })),
    referenceUrl: vi.fn(async (p: string) => `https://signed.example/${p}`),
    getStream: () => stream,
    onRemoteStream: (s) => remote.push(s),
    network: { online: () => online, subscribe: (cb) => { netCbs.add(cb); return () => { netCbs.delete(cb); }; } },
    balance: 300, heartbeatSeconds: 10,
    ...over,
  };
  const s = createStudioSession(deps);
  const views: SessionView[] = [];
  s.subscribe((v) => views.push(v));
  return {
    s, deps, calls, conns, remote, views, netCbs, connect, fetchFn,
    setOnline: (v: boolean) => { online = v; netCbs.forEach((cb) => cb()); },
    to: (url: string) => calls.filter((c) => c.url === url),
    ends: () => calls.filter((c) => c.url === END).map((c) => c.body),
  };
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a normal session", () => {
  it("starts a session, connects with the camera and inputs, goes live, counts down and heartbeats with stats", async () => {
    const t = setup();
    await t.s.start({ ...INPUTS, referencePath: "u/reference/a.jpg" });
    expect(t.to(START)[0].body).toEqual({ settings: { prompt: "an astronaut", expand: true, kind: "prompt" } });
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.conns[0].opts).toMatchObject({ sessionId: "s1", inputs: { prompt: "an astronaut", enablePromptExpansion: true, referenceImageUrl: "https://signed.example/u/reference/a.jpg" } });
    expect(t.s.view()).toMatchObject({ state: "connecting", remaining: 300, sessionLeft: 120 });
    t.conns[0].emit("live");
    expect(t.s.view().state).toBe("live");
    await tick(3000);
    expect(t.s.view()).toMatchObject({ remaining: 297, sessionLeft: 117, stats: { fps: 24 } });
    await tick(7000); // the 10 s heartbeat
    expect(t.to(BEAT)).toHaveLength(1);
    expect(t.to(BEAT)[0].body).toEqual({ sessionId: "s1", stats: { fps: 24, rttMs: 40 } });
    expect(t.s.view()).toMatchObject({ remaining: 290, sessionLeft: 110 });
    expect(t.s.sessionId()).toBe("s1");
  });

  it("Stop ends the session as 'user', closes the connection, clears the video and leaves nothing running", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await tick(2000);
    await t.s.stop();
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "user" }]);
    expect(t.conns[0].closed).toBe(1);
    expect(t.remote.at(-1)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: null, stats: null, remaining: 280 });
    expect(t.s.sessionId()).toBeNull();
    await tick(60_000);
    expect(t.to(BEAT)).toHaveLength(0);
  });

  it("ignores a double click on Go live", async () => {
    const t = setup();
    await Promise.all([t.s.start(INPUTS), t.s.start(INPUTS)]);
    await t.s.start(INPUTS); // and a third while one is open
    expect(t.to(START)).toHaveLength(1);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(3);
  });

  it("does not bill for a reference image it cannot read: no session is created", async () => {
    const t = setup({ referenceUrl: vi.fn(async () => { throw new Error("Could not read file"); }) });
    await t.s.start({ ...INPUTS, referencePath: "u/reference/a.jpg" });
    expect(t.to(START)).toHaveLength(0);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { tone: "error", retryLabel: "Try again" } });
    expect(t.s.view().notice?.text).toMatch(/reference image/i);
  });

  it("will not go live without a live camera, and says so", async () => {
    const t = setup({ getStream: () => null });
    await t.s.start(INPUTS);
    expect(t.to(START)).toHaveLength(0);
    expect(t.s.view().notice?.text).toMatch(/camera/i);
  });
});

describe("a connection that fails must not keep billing (item 1)", () => {
  it("ends the server session as connection_failed, stops all three timers and keeps the reason on screen", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await tick(5000);
    expect(vi.getTimerCount()).toBe(3);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "connection_failed" }]);
    expect(t.conns[0].closed).toBe(1);
    expect(t.remote.at(-1)).toBeNull();
    const v = t.s.view();
    expect(v.state).toBe("failed");
    expect(v.notice).toMatchObject({ tone: "error", retryLabel: "Reconnect" });
    expect(v.notice?.text).toContain("didn't answer within 20 seconds");
    expect(v.notice?.text).toContain("The session was closed.");
    expect(v.notice?.hint).toMatch(/new session, billed from its start/);
    // Nothing more happens: no heartbeats, no countdown, no second end call, the message does not go away.
    const remaining = v.remaining;
    await tick(120_000);
    expect(t.to(BEAT)).toHaveLength(0);
    expect(t.ends()).toHaveLength(1);
    expect(t.s.view()).toMatchObject({ state: "failed", remaining });
    expect(t.s.view().notice?.text).toContain("didn't answer");
  });

  it("a 'closed' that follows a failure does not replace it with a bare 'Closed'", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    t.conns[0].emit("closed");
    await tick(0);
    expect(t.s.view().state).toBe("failed");
  });

  it.each([
    [{ code: "model_error", message: "quota exceeded" }, /quota exceeded/],
    [{ code: "token_refused", message: "x", status: 403 }, /no longer open/],
    [{ code: "token_unreachable", message: "x" }, /internet connection/],
    [{ code: "socket_error", message: "x", status: 1006 }, /dropped or was refused/],
    [{ code: "ice_failed", message: "x" }, /VPN, firewall/],
    [{ code: "connection_lost", message: "x" }, /didn't come back/],
    [{ code: "bad_answer", message: "x" }, /couldn't be used/],
  ] as [LucyFailure, RegExp][])("explains %j in plain language", async (failure, text) => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", failure.message, failure);
    await tick(0);
    expect(t.s.view().notice?.text).toMatch(text);
    expect(t.s.view().notice?.text).not.toMatch(/Timed out|undefined/); // technical text and holes stay out of the headline
  });

  it("a failure with no structured reason still ends the session and shows a message", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", "something odd");
    await tick(0);
    expect(t.s.view()).toMatchObject({ state: "failed" });
    expect(t.s.view().notice?.text).toBeTruthy();
    expect(t.ends()).toHaveLength(1);
  });

  it("if the server can't be reached to close it, says so and closes it as soon as the browser is back online", async () => {
    let endOk = false;
    const t = setup({ routes: { [END]: () => { if (!endOk) throw new TypeError("Failed to fetch"); return json(200, { remaining: 270, secondsBilled: 30 }); } } });
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    expect(t.s.view().notice?.text).toMatch(/couldn't reach the server to close the session/i);
    expect(t.s.view().notice?.text).not.toContain("The session was closed.");
    expect(t.ends()).toHaveLength(1);
    endOk = true;
    t.setOnline(true);
    await tick(0);
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "connection_failed" }, { sessionId: "s1", reason: "connection_failed" }]);
    expect(t.s.view().remaining).toBe(270);
    t.setOnline(true);
    await tick(0);
    expect(t.ends()).toHaveLength(2); // confirmed once: not retried again
  });

  it("a Stop the server never heard about says so, and a Stop it confirmed shows nothing", async () => {
    const down = setup({ routes: { [END]: () => { throw new TypeError("Failed to fetch"); } } });
    await down.s.start(INPUTS);
    await down.s.stop();
    expect(down.s.view().state).toBe("idle");
    expect(down.s.view().notice?.text).toMatch(/couldn't reach the server to close the session/i);

    const up = setup();
    await up.s.start(INPUTS);
    await up.s.stop();
    expect(up.s.view().notice).toBeNull();
    expect(up.ends()).toEqual([{ sessionId: "s1", reason: "user" }]);
  });

  it("an unconfirmed Stop does not overwrite what the user is looking at once they have started again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const t = setup({ routes: { [END]: async () => { if (first) { first = false; await gate; throw new TypeError("Failed to fetch"); } return json(200, { remaining: 1, secondsBilled: 1 }); } } });
    await t.s.start(INPUTS);
    const stopping = t.s.stop();
    await tick(0);
    await t.s.start(INPUTS);
    release();
    await stopping;
    expect(t.s.view().state).not.toBe("idle");
    expect(t.s.view().notice?.text ?? "").not.toMatch(/couldn't reach the server to close/i);
  });

  it("a server error answering the end call counts as unconfirmed too, a 404 does not", async () => {
    const t = setup({ routes: { [END]: () => json(500, { error: "Internal error" }) } });
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    expect(t.s.view().notice?.text).toMatch(/couldn't reach the server/i);
    const u = setup({ routes: { [END]: () => json(404, { error: "Session not found" }) } });
    await u.s.start(INPUTS);
    u.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    expect(u.s.view().notice?.text).toContain("The session was closed.");
  });

  it("a connection that fails before its timers exist leaves no timers behind", async () => {
    const t = setup({ connect: vi.fn((o: ConnectOptions) => { const c = new FakeConn(o); o.onState("failed", "boom", { code: "setup_error", message: "boom" }); return c; }) });
    await t.s.start(INPUTS);
    await tick(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.s.view().state).toBe("failed");
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "connection_failed" }]);
  });

  it("connect() throwing is a failure, not an exception", async () => {
    const t = setup({ connect: vi.fn(() => { throw new Error("RTCPeerConnection is not defined"); }) });
    await expect(t.s.start(INPUTS)).resolves.toBeUndefined();
    await tick(0);
    expect(t.s.view().state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    expect(t.ends()).toHaveLength(1);
  });

  it("callbacks from an attempt that was already replaced or stopped are ignored", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await t.s.applyChanges(INPUTS); // renegotiates: connection #2
    expect(t.conns).toHaveLength(2);
    expect(t.conns[0].closed).toBe(1);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT); // the old one speaks up late
    t.conns[0].emit("live");
    await tick(0);
    expect(t.s.view().state).toBe("connecting");
    expect(t.ends()).toHaveLength(0);
    t.conns[1].emit("live");
    await t.s.stop();
    t.conns[1].emit("failed", "late", { code: "socket_error", message: "late" });
    await tick(0);
    expect(t.s.view().state).toBe("idle");
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "user" }]);
  });
});

describe("Reconnect (item 5)", () => {
  it("after a failure starts a brand-new session and connection, with exactly one set of timers", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    await t.s.reconnect(INPUTS);
    expect(t.to(START)).toHaveLength(2);
    expect(t.conns).toHaveLength(2);
    expect(t.conns[1].opts.sessionId).toBe("s2");
    expect(t.s.sessionId()).toBe("s2");
    expect(t.s.view()).toMatchObject({ state: "connecting", notice: null });
    expect(vi.getTimerCount()).toBe(3);
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "connection_failed" }]); // the old one was ended once, at the failure
    t.conns[1].emit("live");
    await tick(10_000);
    expect(t.to(BEAT).every((c) => c.body.sessionId === "s2")).toBe(true);
  });

  it("while stuck connecting ends the open session as 'reconnect' and starts another; the old connection is closed", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    await t.s.reconnect(INPUTS);
    await tick(0);
    expect(t.conns[0].closed).toBe(1);
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "reconnect" }]);
    expect(t.s.sessionId()).toBe("s2");
    expect(vi.getTimerCount()).toBe(3);
  });

  it("is not held up by a slow end call", async () => {
    const t = setup({ routes: { [END]: () => new Promise<Response>(() => {}) } }); // never answers
    await t.s.start(INPUTS);
    await t.s.reconnect(INPUTS);
    expect(t.s.sessionId()).toBe("s2");
  });

  it("a failed Reconnect fails visibly again and ends its session too", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    await t.s.reconnect(INPUTS);
    t.conns[1].emit("failed", "again", { code: "ice_failed", message: "again" });
    await tick(0);
    expect(t.s.view().state).toBe("failed");
    expect(t.ends().map((e) => e.sessionId)).toEqual(["s1", "s2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry on its own: after a failure nothing starts until the user asks", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(10 * 60_000);
    expect(t.to(START)).toHaveLength(1);
    expect(t.connect).toHaveBeenCalledTimes(1);
  });
});

describe("starting can fail (item 3)", () => {
  it("a network failure is explained, can be retried, and the retry works", async () => {
    let fail = true;
    const t = setup({ routes: { [START]: () => { if (fail) throw new TypeError("Failed to fetch"); return json(200, { sessionId: "s9", maxSeconds: 120, remaining: 300 }); } } });
    await expect(t.s.start(INPUTS)).resolves.toBeUndefined();
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { tone: "error", retryLabel: "Try again" } });
    expect(t.s.view().notice?.text).toMatch(/couldn't reach altrcam/i);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.connect).not.toHaveBeenCalled();
    fail = false;
    await t.s.start(INPUTS);
    expect(t.s.view()).toMatchObject({ state: "connecting", notice: null });
    expect(t.s.sessionId()).toBe("s9");
  });

  it.each([
    [402, { error: "Out of credits" }, /out of credits/i, false],
    [429, { error: "Too many requests, slow down" }, /wait a minute/i, true],
    [503, { error: "Live transformation isn't available yet. The service is not configured." }, /isn't available yet/i, true],
    [500, { error: "Internal error" }, /on our side.*500/i, true],
    [401, { error: "Unauthorized" }, /signed out/i, false],
  ])("HTTP %i gets its own message (retry offered: %s)", async (status, body, text, retry) => {
    const t = setup({ routes: { [START]: () => json(status as number, body) } });
    await t.s.start(INPUTS);
    const v = t.s.view();
    expect(v.state).toBe("idle");
    expect(v.notice?.text).toMatch(text as RegExp);
    expect(Boolean(v.notice?.retryLabel)).toBe(retry);
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.ends()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("out of credits sets the balance to 0 so 'Top up credits' shows", async () => {
    const t = setup({ routes: { [START]: () => json(402, { error: "Out of credits", code: "no_credits" }) } });
    await t.s.start(INPUTS);
    expect(t.s.view().remaining).toBe(0);
  });

  it("a non-JSON error page is handled, not thrown", async () => {
    const t = setup({ routes: { [START]: () => new Response("<html>Bad gateway</html>", { status: 502 }) } });
    await expect(t.s.start(INPUTS)).resolves.toBeUndefined();
    expect(t.s.view().notice?.text).toMatch(/502/);
  });

  it("an OK reply with no session id is reported, not treated as a session", async () => {
    const t = setup({ routes: { [START]: () => json(200, {}) } });
    await t.s.start(INPUTS);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { tone: "error" } });
    expect(t.connect).not.toHaveBeenCalled();
  });

  it("Stop while the server is still creating the session cancels it: the late session is ended and no connection opens", async () => {
    let release!: (r: Response) => void;
    let calls = 0;
    const t = setup({ routes: { [START]: () => (++calls === 1 ? new Promise<Response>((r) => { release = r; }) : json(200, { sessionId: "s2", maxSeconds: 120, remaining: 300 })) } });
    const starting = t.s.start(INPUTS);
    await tick(0);
    expect(t.s.view().state).toBe("connecting");
    await t.s.stop();
    expect(t.s.view().state).toBe("idle");
    release(json(200, { sessionId: "late", maxSeconds: 120, remaining: 300 }));
    await starting;
    await tick(0);
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.ends()).toEqual([{ sessionId: "late", reason: "user" }]);
    expect(t.s.view().state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    await t.s.start(INPUTS); // and Go live works again straight away
    expect(t.s.view().state).toBe("connecting");
  });
});

describe("offline (item 3)", () => {
  it("shows offline, refuses to start without calling the server, and recovers when the browser is back", async () => {
    const t = setup();
    t.setOnline(false);
    expect(t.s.view().offline).toBe(true);
    await t.s.start(INPUTS);
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.s.view()).toMatchObject({ state: "idle", offline: true, notice: null }); // the page's offline banner is the message
    t.setOnline(true);
    expect(t.s.view().offline).toBe(false);
    await t.s.start(INPUTS);
    expect(t.to(START)).toHaveLength(1);
  });

  it("starts out offline if the browser already is", () => {
    const t = setup({ network: { online: () => false, subscribe: () => () => {} } });
    expect(t.s.view().offline).toBe(true);
  });

  it("goes offline during a live session: flagged, session left to the connection to fail", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    t.setOnline(false);
    expect(t.s.view()).toMatchObject({ offline: true, state: "live" });
  });

  it("removes its online/offline listeners when disposed", async () => {
    const t = setup();
    expect(t.netCbs.size).toBe(1);
    t.s.dispose();
    expect(t.netCbs.size).toBe(0);
  });

  it("browserNetwork adds and removes both window listeners", () => {
    const added: string[] = [], removed: string[] = [];
    const w = { navigator: { onLine: true }, addEventListener: (e: string) => added.push(e), removeEventListener: (e: string) => removed.push(e) };
    const net = browserNetwork(w as never);
    expect(net.online()).toBe(true);
    const off = net.subscribe(() => {});
    expect(added.sort()).toEqual(["offline", "online"]);
    off();
    expect(removed.sort()).toEqual(["offline", "online"]);
    w.navigator.onLine = false;
    expect(net.online()).toBe(false);
  });
});

describe("heartbeats", () => {
  it("stop the session, with the right words, when the server says to", async () => {
    const t = setup({ routes: { [BEAT]: () => json(200, { remaining: 0, continue: false, reason: "credits", secondsLeftInSession: 0 }) } });
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await tick(10_000);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { text: "You're out of credits." } });
    expect(vi.getTimerCount()).toBe(0);
    expect(t.ends()).toHaveLength(1);
  });

  it("say 'session limit' for any other reason", async () => {
    const t = setup({ routes: { [BEAT]: () => json(200, { remaining: 100, continue: false, reason: "session_limit", secondsLeftInSession: 0 }) } });
    await t.s.start(INPUTS);
    await tick(10_000);
    expect(t.s.view().notice?.text).toBe("Session limit reached for your plan.");
  });

  it("end the session if the server rejects the heartbeat, but ride out a network blip", async () => {
    const t = setup({ routes: { [BEAT]: () => json(404, { error: "Session not found" }) } });
    await t.s.start(INPUTS);
    await tick(10_000);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { text: "Session ended." } });

    let down = true;
    const u = setup({ routes: { [BEAT]: () => { if (down) throw new TypeError("Failed to fetch"); return json(200, { remaining: 250, continue: true, secondsLeftInSession: 100 }); } } });
    await u.s.start(INPUTS);
    u.conns[0].emit("live");
    await tick(10_000);
    expect(u.s.view().state).toBe("live");
    down = false;
    await tick(10_000);
    expect(u.s.view()).toMatchObject({ state: "live", remaining: 250 });
  });

  it("a rejection of an old session's heartbeat, arriving after a Reconnect, does not stop the new session", async () => {
    let release!: (r: Response) => void;
    let beats = 0;
    const t = setup({ routes: { [BEAT]: () => (++beats === 1 ? new Promise<Response>((r) => { release = r; }) : json(200, { remaining: 250, continue: true, secondsLeftInSession: 100 })) } });
    await t.s.start(INPUTS);
    await tick(10_000); // the first heartbeat is now waiting for the server
    await t.s.reconnect(INPUTS);
    expect(t.s.sessionId()).toBe("s2");
    release(json(404, { error: "Session not found" })); // the old session's answer, late
    await tick(0);
    expect(t.s.sessionId()).toBe("s2");
    expect(t.s.view().state).toBe("connecting");
    expect(t.ends().filter((e) => e.sessionId === "s2")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(3);
  });

  it("a heartbeat answer that arrives after Stop is ignored", async () => {
    let release!: (r: Response) => void;
    const t = setup({ routes: { [BEAT]: () => new Promise<Response>((r) => { release = r; }) } });
    await t.s.start(INPUTS);
    await tick(10_000);
    await t.s.stop();
    const remaining = t.s.view().remaining;
    release(json(200, { remaining: 5, continue: false, reason: "credits", secondsLeftInSession: 0 }));
    await tick(0);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: null, remaining });
  });
});

describe("Apply changes", () => {
  it("renegotiates the same session on a new connection and keeps the timers (including stats) running", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await t.s.applyChanges({ ...INPUTS, prompt: "a pirate" });
    expect(t.conns).toHaveLength(2);
    expect(t.conns[1].opts).toMatchObject({ sessionId: "s1", inputs: { prompt: "a pirate" } });
    expect(t.to(START)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(3);
    t.conns[1].emit("live");
    await tick(2000);
    expect(t.s.view().stats).toMatchObject({ fps: 24 }); // stats still update after renegotiating
  });

  it("does nothing unless live", async () => {
    const t = setup();
    await t.s.applyChanges(INPUTS);
    await t.s.start(INPUTS);
    await t.s.applyChanges(INPUTS); // still connecting
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("a failure of the renegotiated connection ends the session like any other", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await t.s.applyChanges(INPUTS);
    t.conns[1].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    expect(t.s.view().state).toBe("failed");
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "connection_failed" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the running session if the reference image can't be read", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    (t.deps.referenceUrl as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("nope"));
    await t.s.applyChanges({ ...INPUTS, referencePath: "u/reference/x.jpg" });
    expect(t.conns).toHaveLength(1);
    expect(t.conns[0].closed).toBe(0);
    expect(t.s.view().state).toBe("live");
    expect(t.s.view().notice?.text).toMatch(/reference image/i);
  });
});

describe("the camera going away", () => {
  it("ends a live session as camera_lost and tells the user", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await t.s.cameraLost();
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "camera_lost" }]);
    expect(t.s.view()).toMatchObject({ state: "idle", notice: { tone: "error" } });
    expect(t.s.view().notice?.text).toMatch(/camera stopped/i);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.conns[0].closed).toBe(1);
  });

  it("also cancels a start that is still waiting for the server", async () => {
    let release!: (r: Response) => void;
    const t = setup({ routes: { [START]: () => new Promise<Response>((r) => { release = r; }) } });
    const starting = t.s.start(INPUTS);
    await tick(0);
    await t.s.cameraLost();
    release(json(200, { sessionId: "late", maxSeconds: 120, remaining: 300 }));
    await starting;
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.ends()).toEqual([{ sessionId: "late", reason: "user" }]);
  });

  it("does nothing when no session is open", async () => {
    const t = setup();
    await t.s.cameraLost();
    expect(t.fetchFn).not.toHaveBeenCalled();
    expect(t.s.view().notice).toBeNull();
  });
});

describe("unmount", () => {
  it("dispose() closes everything: connection, all timers, listeners, and ends the open session", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("live");
    await tick(3000);
    t.s.dispose();
    await tick(0);
    expect(t.conns[0].closed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.netCbs.size).toBe(0);
    expect(t.ends()).toEqual([{ sessionId: "s1", reason: "user" }]);
    expect(t.remote.at(-1)).toBeNull();
  });

  it("is silent afterwards: no view updates, and a start that was in flight opens nothing", async () => {
    let release!: (r: Response) => void;
    const t = setup({ routes: { [START]: () => new Promise<Response>((r) => { release = r; }) } });
    const starting = t.s.start(INPUTS);
    await tick(0);
    t.s.dispose();
    const seen = t.views.length;
    release(json(200, { sessionId: "late", maxSeconds: 120, remaining: 300 }));
    await starting;
    await tick(60_000);
    expect(t.views.length).toBe(seen);
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.ends()).toEqual([{ sessionId: "late", reason: "user" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is idempotent, and a session that already failed is not ended twice", async () => {
    const t = setup();
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    t.s.dispose(); t.s.dispose();
    await tick(0);
    expect(t.ends()).toHaveLength(1);
  });

  it("an end call still unconfirmed at unmount is tried once more", async () => {
    let ok = false;
    const t = setup({ routes: { [END]: () => { if (!ok) throw new TypeError("offline"); return json(200, { remaining: 1, secondsBilled: 1 }); } } });
    await t.s.start(INPUTS);
    t.conns[0].emit("failed", TIMEOUT.message, TIMEOUT);
    await tick(0);
    ok = true;
    t.s.dispose();
    await tick(0);
    expect(t.ends()).toHaveLength(2);
  });
});
