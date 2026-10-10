/**
 * The site's public origin, for links that leave the browser (referral links, payment return URLs, emails, sitemap).
 * NEXT_PUBLIC_APP_URL when set; otherwise the production domain Vercel exposes automatically
 * (VERCEL_PROJECT_PRODUCTION_URL, e.g. altrcam.vercel.app), so an unset variable never produces "undefined/billing".
 */
export function appUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "https://altrcam.com";
}
