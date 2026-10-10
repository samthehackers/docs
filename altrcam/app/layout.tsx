import type { Metadata, Viewport } from "next";
import "./globals.css";
const url = process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com";
const title = "AltrCam — Be anyone. Live.";
const description = "Restyle your webcam video with realtime AI.";
export const metadata: Metadata = { metadataBase: new URL(url), title: { default: title, template: "%s · AltrCam" }, description, openGraph: { title, description, url, siteName: "AltrCam", type: "website" }, twitter: { card: "summary_large_image", title, description } };
export const viewport: Viewport = { themeColor: "#0b0914", width: "device-width", initialScale: 1 };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en" className="dark"><body className="min-h-screen">{children}</body></html>; }
