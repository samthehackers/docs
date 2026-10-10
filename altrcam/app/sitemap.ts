import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

const base = appUrl();

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: "monthly",
    priority: p === "" ? 1 : 0.6,
  }));
}
