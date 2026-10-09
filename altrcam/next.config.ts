import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { buildCsp } from "./lib/csp";
import { signupBuildError } from "./lib/build-check";

const csp = buildCsp({ clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });

const config: NextConfig = {
  outputFileTracingRoot: __dirname,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/:path*", has: [{ type: "host", value: "altrcam.ai" }], destination: "https://altrcam.com/:path*", permanent: true },
    ];
  },
};

/**
 * A Vercel Production build with SIGNUPS_OPEN=true but no Clerk keys or no DATABASE_URL fails here, naming what is missing.
 * SIGNUPS_OPEN unset or "false" never fails a build (see lib/build-check.ts for why).
 */
export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const problem = signupBuildError(process.env);
    if (problem) throw new Error(`[altrcam] ${problem}`);
  }
  return config;
}
