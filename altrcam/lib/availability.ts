/**
 * What the public pages say about the live AI video, in one place (landing, how-it-works, pricing, FAQ and billing show it).
 *
 * The realtime connection to the AI service has not been run end to end against the real service, so the site says so
 * instead of promising that going live works. Reword or remove this once a real session has been run and checked
 * (GO_LIVE.md, section 7). The Studio has its own notice with the same facts (lib/studio-messages.ts).
 */
import { EARLY_DROP_SECONDS, REFUNDS_PER_DAY } from "@/lib/plans";

/**
 * How credits are counted, word for word wherever the site states the rule. True because lib/metering.ts bills only
 * from studio_sessions.live_at (the first transformed frame) and never bills a session that did not reach it.
 */
export const CREDITS_RULE = "Credits count only while your transformed video is live. If it never connects, you pay nothing.";

/** The early-drop refund, as the site states it. True because of refundEarlyDrop in lib/metering.ts and its limits in lib/plans.ts. */
export const EARLY_DROP_REFUND =
  `If your live video drops within its first ${EARLY_DROP_SECONDS} seconds because the connection or the AI service failed, ` +
  `the credits that session used are given back automatically, up to ${REFUNDS_PER_DAY} times a day.`;

export const LIVE_AVAILABILITY = {
  title: "Live video isn't confirmed yet",
  body:
    "AltrCam's live connection to the AI model hasn't been tested end to end against the real service, so going live may not connect. " +
    CREDITS_RULE,
} as const;
