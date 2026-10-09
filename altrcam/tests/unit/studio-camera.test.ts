/**
 * The Studio's camera controller (lib/studio-camera.ts) with navigator.mediaDevices faked.
 * Covers the failure messages, the dead-stream and unmount races, the track-ended signal and listener cleanup.
 *
 * What this does NOT prove: how a real browser words or sequences its permission prompts and errors.
 */
import { describe, expect, it, vi } from "vitest";
import { createCamera, type CameraDeps } from "@/lib/studio-camera";

class FakeTrack {
  readyState = "live";
  stopped = 0;
  private ended = new Set<() => void>();
  constructor(readonly deviceId = "cam-a") {}
  getSettings() { return { deviceId: this.deviceId }; }
  stop() { this.stopped++; this.readyState = "ended"; }
  addEventListener(e: string, fn: () => void) { if (e === "ended") this.ended.add(fn); }
  removeEventListener(e: string, fn: () => void) { if (e === "ended") this.ended.delete(fn); }
  get listeners() { return this.ended.size; }
  /** The browser ends the track by itself (unplugged, permission revoked). */
  hardwareEnded() { this.readyState = "ended"; [...this.ended].forEach((fn) => fn()); }
}
class FakeStream {
  constructor(readonly video: FakeTrack | null) {}
  getTracks() { return this.video ? [this.video] : []; }
  getVideoTracks() { return this.video ? [this.video] : []; }
}

function setup(over: Partial<CameraDeps> = {}) {
  const tracks: FakeTrack[] = [];
  const gum = vi.fn(async (_c: MediaStreamConstraints): Promise<MediaStream> => { const t = new FakeTrack(`cam-${tracks.length}`); tracks.push(t); return new FakeStream(t) as unknown as MediaStream; });
  const devicesNow: { kind: string; deviceId: string; label: string }[] = [{ kind: "videoinput", deviceId: "cam-0", label: "Built-in" }, { kind: "audioinput", deviceId: "mic", label: "Mic" }];
  const enumerate = vi.fn(async () => devicesNow as unknown as MediaDeviceInfo[]);
  const handlers = new Map<string, Set<() => void>>();
  const md = {
    getUserMedia: gum, enumerateDevices: enumerate,
    addEventListener: (e: string, fn: () => void) => { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(fn); },
    removeEventListener: (e: string, fn: () => void) => { handlers.get(e)?.delete(fn); },
  };
  const attached: (MediaStream | null)[] = [];
  const onLost = vi.fn();
  const cam = createCamera({ mediaDevices: md as never, secureContext: true, size: { width: 640, height: 360 }, attach: (s) => attached.push(s), onLost, ...over });
  return { cam, md, gum, enumerate, tracks, attached, onLost, devicesNow, fire: (e: string) => handlers.get(e)?.forEach((fn) => fn()), listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}
const reject = (name: string) => { const e = new Error(name); e.name = name; return e; };

describe("opening the camera", () => {
  it("asks for video only, at the plan's size, attaches the preview and lists only cameras", async () => {
    const t = setup();
    await t.cam.start();
    expect(t.gum).toHaveBeenCalledWith({ video: { width: 640, height: 360, frameRate: { ideal: 30 } }, audio: false });
    expect(t.cam.view()).toMatchObject({ ready: true, busy: false, problem: null, deviceId: "cam-0" });
    expect(t.cam.view().devices.map((d) => d.label)).toEqual(["Built-in"]);
    expect(t.attached.at(-1)).toBe(t.cam.stream());
    expect(t.cam.hasLiveVideo()).toBe(true);
  });

  it("asks for a specific camera by exact id", async () => {
    const t = setup();
    await t.cam.start("cam-7");
    expect(t.gum.mock.calls[0][0]).toMatchObject({ video: { deviceId: { exact: "cam-7" } } });
  });
});

describe("failures say what is wrong, and leave nothing usable behind", () => {
  it.each([
    ["NotAllowedError", "blocked", /blocked.*address bar/i],
    ["SecurityError", "blocked", /blocked/i],
    ["NotFoundError", "not_found", /no camera was found/i],
    ["NotReadableError", "in_use", /another app or browser tab/i],
    ["AbortError", "in_use", /another app/i],
    ["OverconstrainedError", "overconstrained", /pick another camera/i],
    ["WeirdError", "unknown", /WeirdError/],
  ])("%s → %s", async (name, code, text) => {
    const t = setup();
    t.gum.mockRejectedValueOnce(reject(name));
    await t.cam.start();
    const v = t.cam.view();
    expect(v.problem?.code).toBe(code);
    expect(v.problem?.message).toMatch(text);
    expect(v.problem?.message).toMatch(/Retry camera/);
    expect(v).toMatchObject({ ready: false, busy: false });
    expect(t.cam.stream()).toBeNull();
    expect(t.cam.hasLiveVideo()).toBe(false);
    expect(t.attached.at(-1)).toBeNull();
  });

  it("the messages for the different causes are all different", async () => {
    const seen = new Set<string>();
    for (const name of ["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError"]) {
      const t = setup(); t.gum.mockRejectedValueOnce(reject(name)); await t.cam.start();
      seen.add(t.cam.view().problem!.message);
    }
    const insecure = setup({ mediaDevices: undefined, secureContext: false }); await insecure.cam.start();
    seen.add(insecure.cam.view().problem!.message);
    expect(seen.size).toBe(5);
  });

  it("an insecure page (no mediaDevices) says to use https; a secure one without support says the browser can't", async () => {
    const a = setup({ mediaDevices: undefined, secureContext: false });
    await a.cam.start();
    expect(a.cam.view().problem).toMatchObject({ code: "insecure" });
    expect(a.cam.view().problem?.message).toMatch(/https/);
    const b = setup({ mediaDevices: undefined, secureContext: true });
    await b.cam.start();
    expect(b.cam.view().problem).toMatchObject({ code: "unsupported" });
  });

  it("a failed switch stops the old camera, clears the preview, and 'Go live' has nothing to use", async () => {
    const t = setup();
    await t.cam.start();
    const first = t.tracks[0];
    t.gum.mockRejectedValueOnce(reject("NotReadableError"));
    await t.cam.start("cam-9");
    expect(first.stopped).toBe(1);
    expect(t.cam.stream()).toBeNull();
    expect(t.cam.hasLiveVideo()).toBe(false);
    expect(t.attached.at(-1)).toBeNull();
    expect(t.cam.view().ready).toBe(false);
    expect(t.cam.view().deviceId).toBe("cam-9"); // the select still shows what the user picked
  });

  it("a stream with no video track counts as no camera", async () => {
    const t = setup();
    t.gum.mockResolvedValueOnce(new FakeStream(null) as unknown as MediaStream);
    await t.cam.start();
    expect(t.cam.view().problem?.code).toBe("not_found");
    expect(t.cam.view().ready).toBe(false);
  });
});

describe("Retry camera", () => {
  it("tries again and recovers once the cause is fixed", async () => {
    const t = setup();
    t.gum.mockRejectedValueOnce(reject("NotAllowedError"));
    await t.cam.start();
    expect(t.cam.view().ready).toBe(false);
    await t.cam.retry();
    expect(t.cam.view()).toMatchObject({ ready: true, problem: null });
  });

  it("retries the camera the user picked when it was merely busy, but falls back to the default when it is gone", async () => {
    const t = setup();
    t.gum.mockRejectedValueOnce(reject("NotReadableError"));
    await t.cam.start("cam-7");
    await t.cam.retry();
    expect(t.gum.mock.calls[1][0]).toMatchObject({ video: { deviceId: { exact: "cam-7" } } });
    t.gum.mockRejectedValueOnce(reject("OverconstrainedError"));
    await t.cam.start("cam-7");
    await t.cam.retry();
    expect((t.gum.mock.calls[3][0].video as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it("shows the request as in flight, then settles", async () => {
    const t = setup();
    const seen: boolean[] = [];
    t.cam.subscribe((v) => seen.push(v.busy));
    await t.cam.start();
    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });
});

describe("results that arrive too late", () => {
  const deferred = () => { let resolve!: (s: MediaStream) => void; let rej!: (e: unknown) => void; const p = new Promise<MediaStream>((r, j) => { resolve = r; rej = j; }); return { p, resolve, rej }; };

  it("after unmount: the late stream is stopped and never attached", async () => {
    const t = setup();
    const late = deferred();
    t.gum.mockReturnValueOnce(late.p);
    const starting = t.cam.start();
    t.cam.dispose();
    const track = new FakeTrack();
    late.resolve(new FakeStream(track) as unknown as MediaStream);
    await starting;
    expect(track.stopped).toBe(1);
    expect(t.attached.filter((s) => s !== null)).toHaveLength(0);
    expect(t.cam.stream()).toBeNull();
  });

  it("after a newer request: the older stream is stopped and the newer one wins", async () => {
    const t = setup();
    const slow = deferred();
    t.gum.mockReturnValueOnce(slow.p);
    const first = t.cam.start("cam-a");
    await t.cam.start("cam-b"); // resolves straight away
    const newer = t.cam.stream();
    const stale = new FakeTrack("cam-a");
    slow.resolve(new FakeStream(stale) as unknown as MediaStream);
    await first;
    expect(stale.stopped).toBe(1);
    expect(t.cam.stream()).toBe(newer);
    expect(t.tracks[0].stopped).toBe(0); // the one in use was not touched
  });

  it("an error from a superseded request does not overwrite the newer result", async () => {
    const t = setup();
    const slow = deferred();
    t.gum.mockReturnValueOnce(slow.p);
    const first = t.cam.start("cam-a");
    await t.cam.start("cam-b");
    slow.rej(reject("NotAllowedError"));
    await first;
    expect(t.cam.view()).toMatchObject({ ready: true, problem: null });
  });

  it("an error after unmount is dropped without notifying anyone", async () => {
    const t = setup();
    const late = deferred();
    t.gum.mockReturnValueOnce(late.p);
    const seen = vi.fn();
    t.cam.subscribe(seen);
    const starting = t.cam.start();
    t.cam.dispose();
    seen.mockClear();
    late.rej(reject("NotAllowedError"));
    await starting;
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("the camera going away mid-session", () => {
  it("reports it once, releases the stream, and says what happened", async () => {
    const t = setup();
    await t.cam.start();
    const track = t.tracks[0];
    track.hardwareEnded();
    expect(t.onLost).toHaveBeenCalledTimes(1);
    expect(t.cam.view()).toMatchObject({ ready: false, problem: { code: "disconnected" } });
    expect(t.cam.view().problem?.message).toMatch(/disconnected|stopped/i);
    expect(t.cam.stream()).toBeNull();
    expect(t.attached.at(-1)).toBeNull();
    expect(track.listeners).toBe(0);
    track.hardwareEnded();
    expect(t.onLost).toHaveBeenCalledTimes(1);
  });

  it("after Retry camera the new track is watched too, and the old one no longer is", async () => {
    const t = setup();
    await t.cam.start();
    const old = t.tracks[0];
    t.tracks[0].hardwareEnded();
    await t.cam.retry();
    expect(t.cam.view().ready).toBe(true);
    expect(old.listeners).toBe(0);
    t.tracks[1].hardwareEnded();
    expect(t.onLost).toHaveBeenCalledTimes(2);
  });

  it("stopping the stream ourselves (switching cameras) is not reported as lost", async () => {
    const t = setup();
    await t.cam.start();
    await t.cam.start("cam-5");
    expect(t.onLost).not.toHaveBeenCalled();
    expect(t.tracks[0].listeners).toBe(0);
  });
});

describe("the camera list and cleanup", () => {
  it("refreshes the list when a camera is plugged in or out", async () => {
    const t = setup();
    await t.cam.start();
    t.devicesNow.push({ kind: "videoinput", deviceId: "cam-usb", label: "USB camera" });
    t.fire("devicechange");
    await Promise.resolve(); await Promise.resolve();
    expect(t.cam.view().devices.map((d) => d.label)).toEqual(["Built-in", "USB camera"]);
  });

  it("keeps the old list if listing fails", async () => {
    const t = setup();
    await t.cam.start();
    t.enumerate.mockRejectedValueOnce(new Error("nope"));
    t.fire("devicechange");
    await Promise.resolve(); await Promise.resolve();
    expect(t.cam.view().devices).toHaveLength(1);
  });

  it("dispose() stops the tracks, clears the preview, removes the devicechange listener and is idempotent", async () => {
    const t = setup();
    await t.cam.start();
    expect(t.listenerCount()).toBe(1);
    t.cam.dispose(); t.cam.dispose();
    expect(t.tracks[0].stopped).toBe(1);
    expect(t.tracks[0].listeners).toBe(0);
    expect(t.attached.at(-1)).toBeNull();
    expect(t.listenerCount()).toBe(0);
    t.fire("devicechange");
    expect(t.enumerate).toHaveBeenCalledTimes(1); // only the one from start()
  });

  it("start() after dispose does nothing", async () => {
    const t = setup();
    t.cam.dispose();
    await t.cam.start();
    expect(t.gum).not.toHaveBeenCalled();
  });
});
