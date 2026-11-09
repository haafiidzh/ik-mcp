const STEPS = [
  "Claude (Desktop or Code) starts the server as a local process and talks to it over stdio.",
  "Every tool call is validated against a strict schema and checked against your config: roots, connections, repositories, API profiles.",
  "The pack runs a bounded operation (size, row, time and byte limits) and the result is redacted.",
  "Claude receives a structured result: success or a coded error, plus metadata such as truncated and partial.",
];

export function HowItWorks() {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-2">
      <svg
        viewBox="0 0 560 150"
        role="img"
        aria-labelledby="flow-title flow-desc"
        className="w-full rounded-lg border bg-card p-2 text-foreground"
      >
        <title id="flow-title">How a tool call flows through ik</title>
        <desc id="flow-desc">
          Claude on the left sends a request over stdio to the ik server, which validates it against your config and
          runs it in a pack, then returns a structured result to Claude.
        </desc>
        <g fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="10" y="40" width="110" height="70" rx="8" />
          <rect x="225" y="25" width="150" height="100" rx="8" />
          <rect x="440" y="40" width="110" height="70" rx="8" />
          <path d="M120 65h105M225 95h-105M375 65h65M440 95h-65" strokeDasharray="0" />
        </g>
        <g fill="currentColor" fontSize="13" fontFamily="var(--font-geist-sans), sans-serif" textAnchor="middle">
          <text x="65" y="80">Claude host</text>
          <text x="300" y="62">ik server</text>
          <text x="300" y="82" fontSize="11">validate, then check config</text>
          <text x="300" y="102" fontSize="11">bounded, redacted</text>
          <text x="495" y="72">Pack</text>
          <text x="495" y="90" fontSize="11">fs, db, github, api</text>
          <text x="172" y="58" fontSize="11">stdio request</text>
          <text x="172" y="112" fontSize="11">structured result</text>
        </g>
      </svg>
      <ol className="list-decimal space-y-3 pl-5 text-muted-foreground marker:font-medium marker:text-foreground">
        {STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
