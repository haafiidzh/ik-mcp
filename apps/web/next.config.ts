import type { NextConfig } from "next";

// Static export only: no server runtime, no API routes, no image optimizer (no native build scripts).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: false,
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
