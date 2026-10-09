/** Content-Security-Policy for the app. Pure so it can be unit-tested. */

/**
 * Clerk's frontend API host, decoded from the publishable key (`pk_<test|live>_<base64(host$)>`).
 * Production instances use a custom host such as `clerk.altrcam.com`; clerk-js is loaded from it,
 * so it must be allowed in script-src and connect-src.
 */
export function clerkHostFromKey(pk: string | undefined): string | null {
  const m = pk?.match(/^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/);
  if (!m) return null;
  try {
    const host = Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function buildCsp(opts: { clerkPublishableKey?: string } = {}): string {
  const clerk = clerkHostFromKey(opts.clerkPublishableKey);
  const clerkOrigin = clerk ? [`https://${clerk}`] : [];
  const j = (...p: (string | string[])[]) => p.flat().join(" ");
  return [
    "default-src 'self'",
    j("script-src 'self' 'unsafe-inline' https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com https://js.paystack.co", clerkOrigin),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://img.clerk.com https://*.supabase.co",
    "media-src 'self' blob: https://*.supabase.co",
    "font-src 'self' data:",
    // The fal realtime socket is wss://fal.run (bare host), covered by the `wss:` scheme source.
    j("connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://*.fal.ai https://*.fal.run https://*.supabase.co https://api.paystack.co stun: turn: wss:", clerkOrigin),
    "frame-src https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com https://checkout.paystack.com https://js.paystack.co",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
