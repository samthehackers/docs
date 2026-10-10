/**
 * Everything the Studio tells the user about errors and status, and the pure functions that choose the words.
 * No React and no browser APIs, so the wording can be reviewed, changed and unit-tested in one place.
 */
import type { LucyFailure } from "@/lib/fal/signaling";
import { CREDITS_RULE } from "@/lib/availability";

/**
 * The two standing notes under the preview. Change them here.
 * `unverified`: reword or remove once a real session has been run and checked (GO_LIVE.md, section 7).
 * `videoOnly`: true while the camera is requested with audio:false and the Permissions-Policy is microphone=().
 */
export const STUDIO_NOTICES = {
  videoOnly: "AltrCam transforms video only. Your microphone isn't used, and no audio is captured or sent.",
  unverified: `Live transformation hasn't been tested against the real AI service yet, so connecting may not work. ${CREDITS_RULE}`,
} as const;

export const MESSAGES = {
  reconnectHint: "Reconnect starts a new session. Credits count only once its transformed video is live.",
  sessionClosed: "The session was closed.",
  endUnconfirmed: "We couldn't reach the server to close the session. It will be closed automatically when the server notices it has gone quiet, or when you next start one.",
  offlineIdle: "You're offline. Connect to the internet to go live.",
  offlineLive: "You're offline. The live connection will drop if this lasts.",
  cameraLostLive: "Your camera stopped, so the session was ended.",
  noCamera: "There's no working camera yet. Fix the camera first, then go live.",
  referenceImage: "Couldn't load your reference image. Remove it or try again.",
  outOfCredits: "You're out of credits.",
  sessionLimit: "Session limit reached for your plan.",
  sessionEnded: "Session ended.",
  neverConnected: "The transformed video didn't start in time, so the session was closed. Nothing was charged.",
  unreadableStart: "The server's reply to starting a session was unreadable. Try again.",
} as const;

/** A message shown above the controls. `retryLabel` makes the primary button a retry with that label. */
export interface Notice {
  tone: "error" | "info";
  text: string;
  retryLabel?: string;
  /** A short line under the text, e.g. what a retry will do. */
  hint?: string;
}

// ---------- starting a session ----------

export type StartResult = { network: true } | { status: number; error?: string; code?: string };
export interface StartProblem { message: string; retry: boolean; outOfCredits: boolean }

/** What to say when POST /api/studio/session/start fails. `error` is the server's own message, used where it is specific and honest. */
export function describeStartFailure(r: StartResult): StartProblem {
  if ("network" in r) return { message: "Couldn't reach AltrCam. Check your internet connection, then try again.", retry: true, outOfCredits: false };
  const { status, error, code } = r;
  if (status === 401) return { message: "You've been signed out. Reload the page and sign in again.", retry: false, outOfCredits: false };
  if (status === 402) return { message: MESSAGES.outOfCredits, retry: false, outOfCredits: true };
  // The never-connected pause: the server says how long, and why.
  if (status === 429 && code === "connect_cooldown") return { message: error ?? "Your last few attempts didn't connect, so going live is paused for a few minutes.", retry: true, outOfCredits: false };
  if (status === 429) return { message: "Too many sessions started in a short time. Wait a minute, then try again.", retry: true, outOfCredits: false };
  if (status === 503) return { message: error ?? "Live transformation isn't available right now. Try again later.", retry: true, outOfCredits: false };
  if (status >= 500) return { message: `Something went wrong on our side starting the session (HTTP ${status}). Try again in a moment.`, retry: true, outOfCredits: false };
  return { message: error ?? `Couldn't start a session (HTTP ${status}).`, retry: status !== 403 && status !== 404, outOfCredits: false };
}

// ---------- a connection that failed ----------

/** Plain-language reason for a failed connection attempt. `f.message` stays technical and is not shown here, except for the service's own error text. */
export function describeFailure(f: LucyFailure): string {
  switch (f.code) {
    case "token_refused":
      if (f.status === 401) return "You've been signed out, so the server wouldn't allow the video connection. Reload the page and sign in again.";
      if (f.status === 403) return "The server wouldn't allow the video connection because this session is no longer open.";
      if (f.status === 429) return "Too many connection attempts in a short time. Wait a minute, then reconnect.";
      return `The server refused the video connection request${f.status ? ` (HTTP ${f.status})` : ""}.`;
    case "token_unreachable":
      return "Couldn't get permission for the video connection from AltrCam's server. Check your internet connection.";
    case "socket_error":
      return "The connection to the AI service dropped or was refused.";
    case "model_error": {
      const own = f.message.trim(); // the service's own words; "Model error" is our placeholder when it sent none
      return own && own !== "Model error" ? `The AI service reported an error: ${own}${/[.!?]$/.test(own) ? "" : "."}` : "The AI service reported an error.";
    }
    case "bad_answer":
      return "The AI service replied, but its reply couldn't be used. If this keeps happening, contact support.";
    case "answer_timeout":
      return "The AI service didn't answer within 20 seconds.";
    case "ice_failed":
      return "Your browser couldn't set up a direct video connection. A VPN, firewall or restrictive network may be blocking it. Try a different network.";
    case "connection_lost":
      return "The connection dropped and didn't come back.";
    case "setup_error":
    default:
      return "Your browser couldn't start the video connection.";
  }
}

// ---------- the camera ----------

export type CameraProblemCode = "insecure" | "unsupported" | "blocked" | "not_found" | "in_use" | "overconstrained" | "disconnected" | "unknown";
export interface CameraProblem { code: CameraProblemCode; message: string }

/** What to say when the camera can't be opened. `env` is read from the browser by the caller so this stays pure. */
export function describeCameraError(err: unknown, env: { secureContext: boolean; hasMediaDevices: boolean }): CameraProblem {
  if (!env.hasMediaDevices) {
    return env.secureContext
      ? { code: "unsupported", message: "This browser can't access cameras. Try a recent version of Chrome, Edge, Firefox or Safari." }
      : { code: "insecure", message: "Browsers only allow camera access on secure (https) pages. Open AltrCam at its https address." };
  }
  const name = typeof (err as { name?: unknown })?.name === "string" ? (err as { name: string }).name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { code: "blocked", message: "Camera access is blocked. Allow it from the camera icon in your browser's address bar (or in the site settings), then press Retry camera." };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return { code: "not_found", message: "No camera was found. Plug one in or turn it on, then press Retry camera." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { code: "in_use", message: "Your camera couldn't be started. Another app or browser tab may be using it. Close that, then press Retry camera." };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return { code: "overconstrained", message: "That camera isn't available any more or can't supply the video size AltrCam asks for. Pick another camera or press Retry camera." };
    default:
      return { code: "unknown", message: `Couldn't open the camera${name ? ` (${name})` : ""}. Press Retry camera to try again.` };
  }
}

export const CAMERA_DISCONNECTED: CameraProblem = {
  code: "disconnected",
  message: "Your camera was disconnected or stopped. Plug it back in or pick another camera, then press Retry camera.",
};
