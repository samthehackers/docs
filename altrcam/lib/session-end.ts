/**
 * Why the browser ended a studio session. Sent to /api/studio/session/end and stored as studio_sessions.end_reason,
 * so Admin can tell a person pressing Stop from a connection that failed. The server only accepts these values.
 * The server sets the others itself: credits, session_limit, stale, superseded.
 */
export const CLIENT_END_REASONS = ["user", "connection_failed", "camera_lost", "reconnect"] as const;
export type ClientEndReason = (typeof CLIENT_END_REASONS)[number];
