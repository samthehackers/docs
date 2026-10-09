/**
 * What the public pages say about the live AI video, in one place (landing, how-it-works, pricing, FAQ and billing show it).
 *
 * The realtime connection to the AI service has not been run end to end against the real service, so the site says so
 * instead of promising that going live works. Reword or remove this once a real session has been run and checked
 * (GO_LIVE.md, section 7). The Studio has its own notice with the same facts (lib/studio-messages.ts).
 */

/**
 * How credits are counted, word for word wherever the site states the rule. True because lib/metering.ts bills only
 * from studio_sessions.live_at (the first transformed frame) and never bills a session that did not reach it.
 */
export const CREDITS_RULE = "Credits count only while your transformed video is live. If it never connects, you pay nothing.";

export const LIVE_AVAILABILITY = {
  title: "Live video isn't confirmed yet",
  body:
    "AltrCam's live connection to the AI model hasn't been tested end to end against the real service, so going live may not connect. " +
    CREDITS_RULE,
} as const;
