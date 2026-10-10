import type { MetadataRoute } from "next";
import { appUrl } from "@/lib/app-url";

const base = appUrl();

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/admin", "/dashboard", "/studio", "/billing", "/history", "/presets", "/settings", "/support"] },
    sitemap: `${base}/sitemap.xml`,
  };
}
