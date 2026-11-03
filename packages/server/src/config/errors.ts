export interface ConfigIssue {
  /** JSON path such as `$.databases[0].databasePath`. */
  path: string;
  message: string;
}

/** Startup config failure. Message lists JSON paths and rules only, never values. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(
      "Invalid configuration:\n" + issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}
