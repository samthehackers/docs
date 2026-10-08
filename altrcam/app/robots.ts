import type { MetadataRoute } from "next";

const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/dashboard", "/studio", "/billing", "/history", "/presets", "/settings", "/support"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
