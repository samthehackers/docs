/** Content-Security-Policy for the app. Pure so it can be unit-tested. */

/**
 * The origin of the Supabase project the browser talks to for Auth (`NEXT_PUBLIC_SUPABASE_URL`). Hosted projects are
 * already covered by `https://*.supabase.co`; this adds a custom domain or a local stack (`http://127.0.0.1:54321`).
 * Anything that is not a plain http(s) origin is ignored, so nothing odd can reach the header.
 */
export function supabaseOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function buildCsp(opts: { supabaseUrl?: string } = {}): string {
  const origin = supabaseOrigin(opts.supabaseUrl);
  const extra = origin && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(origin) ? [origin] : [];
  const j = (...p: (string | string[])[]) => p.flat().join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://js.paystack.co",
    "style-src 'self' 'unsafe-inline'",
    // Google sign-in avatars come from googleusercontent.com.
    "img-src 'self' data: blob: https://*.supabase.co https://*.googleusercontent.com",
    "media-src 'self' blob: https://*.supabase.co",
    "font-src 'self' data:",
    // The fal realtime socket is wss://fal.run (bare host), covered by the `wss:` scheme source.
    j("connect-src 'self' https://*.fal.ai https://*.fal.run https://*.supabase.co https://api.paystack.co stun: turn: wss:", extra),
    "frame-src https://checkout.paystack.com https://js.paystack.co",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
