/**
 * Browser-only. Calls `onFrame` once, when the <video> showing the transformed stream renders its first frame. That
 * moment is what the server bills from (POST /api/studio/session/live), so it must be a real frame, not just a
 * connection: `requestVideoFrameCallback` fires when a frame is presented. `loadeddata` (the first frame's data is
 * available) and `playing` are listened to as well: they are the fallback where requestVideoFrameCallback does not exist,
 * and a safety net where it exists but may not fire (some browsers skip it for a video that is scrolled out of view).
 * Whichever comes first wins. Returns the cancel function; nothing fires after it.
 */
type FrameVideo = Pick<HTMLVideoElement, "addEventListener" | "removeEventListener"> & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function watchFirstFrame(v: FrameVideo, onFrame: () => void): () => void {
  let done = false;
  let handle: number | null = null;
  const cleanup = () => {
    done = true;
    if (handle !== null) { try { v.cancelVideoFrameCallback?.(handle); } catch { /* already gone */ } handle = null; }
    v.removeEventListener("loadeddata", fire);
    v.removeEventListener("playing", fire);
  };
  function fire() {
    if (done) return;
    cleanup();
    onFrame();
  }
  if (typeof v.requestVideoFrameCallback === "function") handle = v.requestVideoFrameCallback(() => fire());
  v.addEventListener("loadeddata", fire);
  v.addEventListener("playing", fire);
  return cleanup;
}
