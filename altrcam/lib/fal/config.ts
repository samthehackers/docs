/** The only fal app AltrCam talks to. */
export const FAL_APP = "decart/lucy-2-5/realtime";
/** The fal client sends the app *alias* (2nd path segment) when minting realtime tokens; our own token request does the same. */
export const FAL_APP_ALIAS = "lucy-2-5";
export const FAL_APP_ALIASES = [FAL_APP_ALIAS, FAL_APP];
export const SESSION_HEADER = "x-altrcam-session";
/**
 * Lifetime of a realtime connection token, in seconds: what the Studio asks for, and the most the proxy will mint. Kept
 * short because "live" is reported by the browser: a token minted for a session that never goes live should be useless
 * soon after (whether fal ends an already-open connection when its token expires is unverified; README_LIMITATIONS.md).
 */
export const TOKEN_EXPIRATION_SECONDS = 120;
