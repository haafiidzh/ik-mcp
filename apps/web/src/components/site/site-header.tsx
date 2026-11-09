import Link from "next/link";
import { ScrollProgress } from "@/components/motion/scroll-progress";
import { HeaderGithubLink } from "./github-link";
import { NavLinks } from "./nav-links";
import { ThemeToggle } from "./theme-toggle";
import { Wordmark } from "./logo";

export function SiteHeader() {
  return (
    <header className="site-header sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
        <Link href="/" aria-label="ik, home" className="ik-logo-link rounded-md py-1">
          <Wordmark follow />
        </Link>
        <nav aria-label="Main" className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
          <NavLinks />
        </nav>
        <div className="flex items-center gap-2">
          <HeaderGithubLink />
          <ThemeToggle />
        </div>
      </div>
      <ScrollProgress />
    </header>
  );
}
