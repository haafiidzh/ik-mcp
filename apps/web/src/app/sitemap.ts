import type { MetadataRoute } from "next";
import { ROUTES } from "@/lib/site";

export const dynamic = "force-static";

// Relative paths on purpose: no domain is hard-coded. Replace with absolute URLs once a domain exists.
export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((url) => ({ url }));
}
