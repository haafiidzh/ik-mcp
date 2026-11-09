// Page enter: a plain wrapper, no client JS. The animation is CSS (motion-chrome.css) and gated by
// prefers-reduced-motion: no-preference; the HTML content is always present and visible.
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
