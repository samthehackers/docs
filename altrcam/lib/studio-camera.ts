/**
 * Browser-only. The Studio's camera, kept out of the React component so it can be tested with fakes.
 *
 * Guarantees: a stream that arrives after a newer request, a failure or an unmount is stopped at once; a failure
 * clears the stream and the preview (never leaves a dead stream that "Go live" would accept); the live video track
 * ending (unplugged, permission revoked) is reported; every listener added here is removed by dispose().
 */
import { CAMERA_DISCONNECTED, describeCameraError, type CameraProblem } from "@/lib/studio-messages";

export interface CameraView {
  /** A live video track is attached. */
  ready: boolean;
  /** A request is in flight. */
  busy: boolean;
  devices: MediaDeviceInfo[];
  deviceId: string;
  problem: CameraProblem | null;
}

export const EMPTY_CAMERA_VIEW: CameraView = { ready: false, busy: false, devices: [], deviceId: "", problem: null };

type MediaDevicesLike = Pick<MediaDevices, "getUserMedia" | "enumerateDevices" | "addEventListener" | "removeEventListener">;

export interface CameraDeps {
  /** navigator.mediaDevices; undefined on insecure pages and old browsers. */
  mediaDevices: MediaDevicesLike | undefined;
  secureContext: boolean;
  size: { width: number; height: number };
  /** Show the stream in the preview, or clear it with null. */
  attach: (s: MediaStream | null) => void;
  /** The video track ended while we held it (camera unplugged, permission revoked). The stream is already released. */
  onLost: () => void;
}

export interface Camera {
  view: () => CameraView;
  subscribe: (fn: (v: CameraView) => void) => () => void;
  /** Open the default camera, or the one with this id. */
  start: (deviceId?: string) => Promise<void>;
  /** Try again after a problem: the same camera, unless that one is gone. */
  retry: () => Promise<void>;
  stream: () => MediaStream | null;
  hasLiveVideo: () => boolean;
  dispose: () => void;
}

export function createCamera(d: CameraDeps): Camera {
  let view: CameraView = EMPTY_CAMERA_VIEW;
  const listeners = new Set<(v: CameraView) => void>();
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let request = 0; // bumped by every start() and by dispose(): an older request's result is stale
  let wanted: string | undefined;
  let disposed = false;

  const set = (patch: Partial<CameraView>) => {
    view = { ...view, ...patch };
    if (!disposed) listeners.forEach((fn) => fn(view));
  };

  const env = () => ({ secureContext: d.secureContext, hasMediaDevices: Boolean(d.mediaDevices?.getUserMedia) });

  function release() {
    track?.removeEventListener("ended", onEnded);
    track = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    d.attach(null);
  }

  function onEnded() {
    release();
    set({ ready: false, busy: false, problem: CAMERA_DISCONNECTED });
    d.onLost();
  }

  async function refreshDevices() {
    try {
      const all = (await d.mediaDevices!.enumerateDevices()).filter((x) => x.kind === "videoinput");
      set({ devices: all });
    } catch { /* keep the list we have */ }
  }

  const onDeviceChange = () => { void refreshDevices(); };
  d.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  async function start(deviceId?: string) {
    if (disposed) return;
    const mine = ++request;
    wanted = deviceId;
    release(); // the old stream goes first: a failed switch must not leave it behind for "Go live" to pick up
    set({ ready: false, busy: true, problem: null, ...(deviceId !== undefined ? { deviceId } : {}) });
    const md = d.mediaDevices;
    if (!md?.getUserMedia) { set({ busy: false, problem: describeCameraError(undefined, env()) }); return; }
    let s: MediaStream;
    try {
      s = await md.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), ...d.size, frameRate: { ideal: 30 } }, audio: false });
    } catch (e) {
      if (mine !== request) return;
      set({ busy: false, problem: describeCameraError(e, env()) });
      return;
    }
    if (mine !== request) { s.getTracks().forEach((t) => t.stop()); return; } // a newer request, or unmounted, while the prompt was open
    const video = s.getVideoTracks()[0];
    if (!video) { s.getTracks().forEach((t) => t.stop()); set({ busy: false, problem: describeCameraError({ name: "NotFoundError" }, env()) }); return; }
    stream = s;
    track = video;
    video.addEventListener("ended", onEnded);
    d.attach(s);
    set({ ready: true, busy: false, problem: null, deviceId: video.getSettings().deviceId ?? deviceId ?? "" });
    await refreshDevices();
  }

  return {
    view: () => view,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start,
    retry: () => {
      const gone = view.problem?.code === "not_found" || view.problem?.code === "overconstrained" || view.problem?.code === "disconnected";
      return start(gone ? undefined : wanted);
    },
    stream: () => stream,
    hasLiveVideo: () => track?.readyState === "live",
    dispose: () => {
      if (disposed) return;
      request++;
      release();
      d.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      disposed = true;
      listeners.clear();
    },
  };
}
