export const SITE_NAME = "ik";
export const SITE_TAGLINE = "Controlled access for Claude to your dev workspace";
export const SITE_DESCRIPTION =
  "ik is a local-first MCP server (stdio) that gives Claude controlled, read-only-by-default access to your filesystem, databases, GitHub, custom APIs and multi-service workflows. Free, no hosted service.";

export const NAV = [
  { href: "/install", label: "Install" },
  { href: "/tools", label: "Tools" },
  { href: "/security", label: "Security" },
  { href: "/demo", label: "Demo" },
] as const;

/** Every public route, used by the sitemap. */
export const ROUTES = ["/", "/install", "/tools", "/security", "/demo"] as const;

/** Public repository. Single source of truth: the publish name is still open (Q9), so change it only here. */
export const REPO_URL = "https://github.com/haafiidzh/ik-mcp";
