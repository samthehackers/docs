/**
 * Why the browser ended a studio session. Sent to /api/studio/session/end and stored as studio_sessions.end_reason,
 * so Admin can tell a person pressing Stop from a connection that failed. The server only accepts these values.
 * The server sets the others itself: credits, session_limit, stale, superseded, failed_connect (a session that never
 * showed a transformed frame within its connect window, or that failed before it did).
 */
export const CLIENT_END_REASONS = ["user", "connection_failed", "camera_lost", "reconnect"] as const;
export type ClientEndReason = (typeof CLIENT_END_REASONS)[number];

/**
 * The failure code the browser may send with reason connection_failed (lib/fal/signaling.ts FailureCode, plus the
 * Studio's own connect_timeout). Stored as studio_sessions.failure_code; some of them make an early drop refundable
 * (REFUNDABLE_FAILURES in lib/plans.ts).
 */
export const CLIENT_FAILURE_CODES = [
  "token_refused", "token_unreachable", "socket_error", "model_error", "bad_answer", "answer_timeout", "ice_failed",
  "connection_lost", "setup_error", "connect_timeout",
] as const;
export type ClientFailureCode = (typeof CLIENT_FAILURE_CODES)[number];
