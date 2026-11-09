import type { MetadataRoute } from "next";

export const dynamic = "force-static";

// No Sitemap line: absolute URLs need a domain, which is not decided yet (see docs/OPEN-QUESTIONS.md, P7).
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/" } };
}
