/**
 * What the public pages say about the live AI video, in one place (landing and how-it-works both show it).
 *
 * The realtime connection to the AI service has not been run end to end against the real service, so the site says so
 * instead of promising that going live works. Reword or remove this once a real session has been run and checked
 * (GO_LIVE.md, section 7). The Studio has its own notice with the same facts (lib/studio-messages.ts).
 */
export const LIVE_AVAILABILITY = {
  title: "Live video isn't confirmed yet",
  body:
    "AltrCam's live connection to the AI model hasn't been tested end to end against the real service, so going live may not connect. " +
    "Credits are counted from when you press Go live, even if the connection fails. You can still create an account and look around.",
} as const;
