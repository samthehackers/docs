import type { NextConfig } from "next";
import { buildCsp } from "./lib/csp";

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
export default config;
