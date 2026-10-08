import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import "./globals.css";

const url = process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com";
const title = "AltrCam — Be anyone. Live.";
const description = "Turn your webcam into anyone, anything, anywhere — in realtime. AltrCam transforms your live video with AI.";

export const metadata: Metadata = {
  metadataBase: new URL(url),
  title: { default: title, template: "%s · AltrCam" },
  description,
  openGraph: { title, description, url, siteName: "AltrCam", type: "website" },
  twitter: { card: "summary_large_image", title, description },
};
export const viewport: Viewport = { themeColor: "#0b0914", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={{ baseTheme: dark }}>
      <html lang="en" className="dark">
        <body className="min-h-screen">{children}</body>
      </html>
    </ClerkProvider>
  );
}
