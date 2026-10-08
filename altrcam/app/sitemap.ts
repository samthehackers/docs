import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: "monthly",
    priority: p === "" ? 1 : 0.6,
  }));
}
