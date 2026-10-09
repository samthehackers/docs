import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { clerkConfigured } from "@/lib/config";
import { AUTH_URLS } from "@/lib/routes";
import "./globals.css";

const url = process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com";
const title = "AltrCam — Be anyone. Live.";
const description = "AltrCam is built to restyle your webcam video with a realtime AI model: a character, a backdrop, an outfit or an art style. Live video has not been tested end to end yet.";

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: { default: title, template: "%s · AltrCam" },
  description,
  openGraph: { title, description, url, siteName: "AltrCam", type: "website" },
  twitter: { card: "summary_large_image", title, description },
};
export const viewport: Viewport = { themeColor: "#0b0914", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const page = (
    <html lang="en" className="dark">
      <body className="min-h-screen">{children}</body>
    </html>
  );
  // Clerk throws during prerender without a key; public pages must build and render without one.
  return clerkConfigured() ? <ClerkProvider appearance={{ baseTheme: dark }} {...AUTH_URLS}>{page}</ClerkProvider> : page;
}
