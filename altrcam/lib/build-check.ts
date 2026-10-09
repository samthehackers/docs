/**
 * Build-time guard for the sign-up switch. next.config.ts runs it while `next build` loads the config, so a bad combination fails
 * the deploy instead of shipping a sign-up page that cannot work. Pure (no imports, no `@/` paths: next.config.ts loads this file
 * before the app's path aliases exist) so it can be unit-tested.
 *
 * What it fails: a Vercel PRODUCTION build (VERCEL_ENV=production) with SIGNUPS_OPEN=true but a credential that sign-up needs
 * missing, or with SIGNUPS_OPEN set to something other than "true"/"false".
 *
 * What it deliberately does NOT fail: a build with SIGNUPS_OPEN unset or "false". Production has no credentials today, and
 * failing those builds would block every deploy; the site then stays explicitly closed ("Sign-up isn't open yet"). Preview and
 * local builds are never failed by it. See docs/SETUP.md, "The sign-up switch".
 */
export const SIGNUP_REQUIRED_ENV = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "DATABASE_URL"] as const;

/** The reason this build must fail, or null. Names variables, never their values. */
export function signupBuildError(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV !== "production") return null;
  const flag = env.SIGNUPS_OPEN;
  if (flag === undefined || flag === "" || flag === "false") return null;
  if (flag !== "true") {
    return 'SIGNUPS_OPEN must be exactly "true" or "false" (or unset, which means "false"). Fix it in Vercel → Settings → Environment Variables (Production) and redeploy. See altrcam/docs/SETUP.md.';
  }
  const missing = SIGNUP_REQUIRED_ENV.filter((n) => !env[n]);
  if (!missing.length) return null;
  const them = missing.length === 1 ? "it" : "them";
  return `SIGNUPS_OPEN=true, but this Production build is missing ${missing.join(", ")}. Sign-up needs both Clerk keys and DATABASE_URL. ` +
    `Add ${them} in Vercel → Settings → Environment Variables (Production) and redeploy, or set SIGNUPS_OPEN=false to keep sign-up closed. See altrcam/docs/SETUP.md.`;
}
