/** The only fal app AltrCam talks to. */
export const FAL_APP = "decart/lucy-2-5/realtime";
/** The fal client sends the app *alias* (2nd path segment) when minting realtime tokens; our own token request does the same. */
export const FAL_APP_ALIAS = "lucy-2-5";
export const FAL_APP_ALIASES = [FAL_APP_ALIAS, FAL_APP];
export const SESSION_HEADER = "x-altrcam-session";
