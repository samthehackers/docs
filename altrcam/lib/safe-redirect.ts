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
  // Resolving collapses dot segments, so `/.//evil.com` or `/%2e%2e//evil.com` become `//evil.com`: judge the RESOLVED path.
  // Decode repeatedly too, so `%252e` style double encoding is judged on what a later decode would produce.
  try {
    const u = new URL(next, "http://same.invalid");
    if (u.origin !== "http://same.invalid") return fallback;
    const resolved = u.pathname + u.search + u.hash;
    let cur = resolved;
    for (let i = 0; i < 4; i++) {
      if (!cur.startsWith("/") || cur.startsWith("//") || cur.startsWith("/\\")) return fallback;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f\\]/.test(cur)) return fallback;
      // What a later decode-and-resolve step (a proxy, a client) would see must not turn into a protocol-relative URL either.
      try { const p = new URL(cur, "http://same.invalid").pathname; if (p.startsWith("//") || p.startsWith("/\\")) return fallback; } catch { return fallback; }
      let nextCur: string;
      try { nextCur = decodeURIComponent(cur); } catch { return fallback; }
      if (nextCur === cur) break;
      cur = nextCur;
    }
    return resolved;
  } catch {
    return fallback;
  }
}

/** Builds the redirect target by assigning only path, query and hash onto our own origin, so it can never leave it. */
export function sameOriginUrl(origin: string, path: string): URL {
  const target = new URL(origin);
  const rel = new URL(path, "http://same.invalid");
  target.pathname = rel.pathname; target.search = rel.search; target.hash = rel.hash;
  return target;
}

/** Short codes for the sign-in page; the page turns them into a friendly sentence. Nothing from the URL is echoed raw. */
export type AuthErrorCode = "link_expired" | "link_invalid" | "access_denied" | "auth_failed" | "other_browser";

export function authErrorCode(error: string | null, description: string | null): AuthErrorCode {
  const text = `${error ?? ""} ${description ?? ""}`.toLowerCase();
  // PKCE links only sign you in from the browser that asked for them (it holds the code verifier). Supabase has already
  // verified the emailed token by the time it redirects here, so a confirmation link did confirm the address.
  if (/code.?verifier/.test(text)) return "other_browser";
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
  other_browser: "That link can only sign you in from the browser where you asked for it. If you were confirming your email, it is confirmed: sign in below. For a password reset, request a new link from this browser.",
};

export function authErrorMessage(code: string | string[] | undefined): string | null {
  const c = Array.isArray(code) ? code[0] : code;
  return c && c in AUTH_ERROR_MESSAGES ? AUTH_ERROR_MESSAGES[c as AuthErrorCode] : null;
}
