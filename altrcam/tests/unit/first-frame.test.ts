/**
 * The first-frame watcher (lib/first-frame.ts) with a fake <video>. Billing starts when it fires, so it must fire once,
 * on a frame, through requestVideoFrameCallback where the browser has it and loadeddata/playing otherwise, and never
 * after it has been cancelled. What this does NOT prove: when a real browser fires these for a real WebRTC stream.
 */
import { describe, expect, it, vi } from "vitest";
import { watchFirstFrame } from "@/lib/first-frame";

function fakeVideo(rvfc: boolean) {
  const listeners = new Map<string, Set<() => void>>();
  const frameCbs = new Map<number, () => void>();
  let next = 1;
  const v = {
    addEventListener: (e: string, cb: () => void) => { if (!listeners.has(e)) listeners.set(e, new Set()); listeners.get(e)!.add(cb); },
    removeEventListener: (e: string, cb: () => void) => { listeners.get(e)?.delete(cb); },
    ...(rvfc ? {
      requestVideoFrameCallback: (cb: () => void) => { const h = next++; frameCbs.set(h, cb); return h; },
      cancelVideoFrameCallback: (h: number) => { frameCbs.delete(h); },
    } : {}),
  };
  return {
    v,
    emit: (e: string) => [...(listeners.get(e) ?? [])].forEach((cb) => cb()),
    frame: () => [...frameCbs.values()].forEach((cb) => cb()),
    pending: () => frameCbs.size + [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("watchFirstFrame", () => {
  it("fires once on the first presented frame (requestVideoFrameCallback) and then removes everything", () => {
    const f = fakeVideo(true);
    const cb = vi.fn();
    watchFirstFrame(f.v as never, cb);
    expect(cb).not.toHaveBeenCalled();
    f.frame();
    f.frame();
    f.emit("loadeddata");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(f.pending()).toBe(0);
  });

  it("falls back to loadeddata or playing where requestVideoFrameCallback does not exist", () => {
    for (const ev of ["loadeddata", "playing"]) {
      const f = fakeVideo(false);
      const cb = vi.fn();
      watchFirstFrame(f.v as never, cb);
      f.emit(ev);
      f.emit("loadeddata");
      expect(cb).toHaveBeenCalledTimes(1);
      expect(f.pending()).toBe(0);
    }
  });

  it("does not fire for events that are not a frame", () => {
    const f = fakeVideo(false);
    const cb = vi.fn();
    watchFirstFrame(f.v as never, cb);
    f.emit("loadstart");
    f.emit("loadedmetadata");
    expect(cb).not.toHaveBeenCalled();
  });

  it("never fires after it was cancelled (the stream went away first)", () => {
    const f = fakeVideo(true);
    const cb = vi.fn();
    const cancel = watchFirstFrame(f.v as never, cb);
    cancel();
    f.frame();
    f.emit("loadeddata");
    expect(cb).not.toHaveBeenCalled();
    expect(f.pending()).toBe(0);
  });
});
