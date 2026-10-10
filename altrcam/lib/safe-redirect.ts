/**
 * Where to send someone after an auth link, from an untrusted `next` query parameter. Only a same-origin relative path is
 * accepted: it must start with exactly one `/`, and `//evil.com`, `/\evil.com`, `/%2F%2Fevil.com`, schemes and control
 * characters are all refused (browsers treat `/\` like `//`, and strip tabs/newlines before parsing).
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || typeof next !== "string") return fallback;
  let decoded = next;
  try { decoded = decodeURIComponent(next); } catch { return fallback; }
  for (const candidate of [next, decoded]) {
    if (!candidate.startsWith("/")) return fallback;
    if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return fallback;
  }
  // Final check: resolved against a dummy origin it must stay on that origin.
  try {
    const u = new URL(next, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}

/** Short codes for the sign-in page; the page turns them into a friendly sentence. Nothing from the URL is echoed raw. */
export type AuthErrorCode = "link_expired" | "link_invalid" | "access_denied" | "auth_failed";

export function authErrorCode(error: string | null, description: string | null): AuthErrorCode {
  const text = `${error ?? ""} ${description ?? ""}`.toLowerCase();
  if (/expired/.test(text)) return "link_expired";
  if (/access_denied|denied|cancel/.test(text)) return "access_denied";
  if (/invalid|otp|token|code/.test(text)) return "link_invalid";
  return "auth_failed";
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  link_expired: "That link has expired. Sign in again, or request a new email.",
  link_invalid: "That link is invalid or has already been used. Request a new one and open it in this browser.",
  access_denied: "Sign-in was cancelled.",
  auth_failed: "We couldn't sign you in with that link. Please try again.",
};

export function authErrorMessage(code: string | string[] | undefined): string | null {
  const c = Array.isArray(code) ? code[0] : code;
  return c && c in AUTH_ERROR_MESSAGES ? AUTH_ERROR_MESSAGES[c as AuthErrorCode] : null;
}
