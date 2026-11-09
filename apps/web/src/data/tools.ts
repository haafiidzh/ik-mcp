// Hand-maintained from .claude/docs/04-requirements-and-flows.md sections 3-5 and the registered tool names in
// packages/server/src/tools (checked 2026-11-03). Not generated: see docs/OPEN-QUESTIONS.md "P7" about drift.

export type PackId = "server" | "filesystem" | "database" | "github" | "api" | "workspace";
export type ToolStatus = "implemented" | "in-development" | "not-shipped";

export type Tool = {
  name: string;
  summary: string;
  inputs: string;
  access: "read" | "write";
  status: ToolStatus;
  note?: string;
};

export type Pack = {
  id: PackId;
  title: string;
  blurb: string;
  status: ToolStatus;
  statusNote: string;
  tools: Tool[];
};

export const PACKS: Pack[] = [
  {
    id: "server",
    title: "Server",
    blurb: "Health and limits of the running server.",
    status: "implemented",
    statusNote: "Always registered.",
    tools: [
      {
        name: "server_get_status",
        summary: "Server name and version, protocol, which packs are enabled, whether writes are allowed, uptime and the limits in force.",
        inputs: "none",
        access: "read",
        status: "implemented",
        note: "Shows no absolute paths and no environment values.",
      },
    ],
  },
  {
    id: "filesystem",
    title: "Filesystem",
    blurb: "Browse and search only the workspaces you configured. Paths are workspace-relative.",
    status: "implemented",
    statusNote: "Implemented and security-tested (QA passed for this pack).",
    tools: [
      { name: "fs_list_directory", summary: "List entries of a directory. Blocked and ignored entries are hidden.", inputs: "workspace, path?, limit?", access: "read", status: "implemented" },
      { name: "fs_get_file_info", summary: "Name, size, modified time, extension and whether the file is text.", inputs: "workspace, path", access: "read", status: "implemented" },
      { name: "fs_read_file", summary: "Read a text file, optionally a line range. Large files are cut and marked truncated; binary files are refused.", inputs: "workspace, path, startLine?, endLine?", access: "read", status: "implemented" },
      { name: "fs_search_files", summary: "Find files by glob or name substring.", inputs: "workspace, pattern, path?, limit?", access: "read", status: "implemented" },
      { name: "fs_search_content", summary: "Literal text search inside files, with snippets.", inputs: "workspace, query, path?, caseSensitive?, extensions?, limit?", access: "read", status: "implemented" },
      { name: "fs_get_directory_tree", summary: "Nested tree to a capped depth, skipping ignored directories.", inputs: "workspace, path?, depth?", access: "read", status: "implemented" },
    ],
  },
  {
    id: "database",
    title: "Database",
    blurb: "Read-only SQLite and PostgreSQL access through named connections.",
    status: "implemented",
    statusNote: "Implemented and security-tested (QA passed for this pack).",
    tools: [
      { name: "db_list_connections", summary: "Configured connections. Never shows host, user, password or file path.", inputs: "none", access: "read", status: "implemented" },
      { name: "db_list_tables", summary: "Tables and views of a connection.", inputs: "connection, schema?", access: "read", status: "implemented" },
      { name: "db_describe_table", summary: "Columns, primary key and foreign keys.", inputs: "connection, table, schema?", access: "read", status: "implemented" },
      { name: "db_list_relationships", summary: "Foreign-key relationships between tables.", inputs: "connection, schema?", access: "read", status: "implemented" },
      { name: "db_execute_readonly_query", summary: "One SELECT-style statement, validated, row-capped and time-limited, on a read-only connection.", inputs: "connection, sql, maxRows?", access: "read", status: "implemented", note: "Writes are rejected with QUERY_REJECTED." },
      { name: "db_explain_query", summary: "Plain EXPLAIN only. Never ANALYZE.", inputs: "connection, sql", access: "read", status: "implemented" },
    ],
  },
  {
    id: "github",
    title: "GitHub",
    blurb: "Read repositories, issues, pull requests and commits for allowlisted repositories only.",
    status: "implemented",
    statusNote: "Read tools implemented and security-tested. The two write tools are not shipped.",
    tools: [
      { name: "github_list_repositories", summary: "Allowlisted repositories only.", inputs: "owner?, limit?, page?", access: "read", status: "implemented" },
      { name: "github_get_repository", summary: "Default branch, visibility, description, topics, counts.", inputs: "owner, repo", access: "read", status: "implemented" },
      { name: "github_list_issues", summary: "Issues (pull requests excluded), by state and labels.", inputs: "owner, repo, state?, labels?, limit?, page?", access: "read", status: "implemented" },
      { name: "github_get_issue", summary: "One issue with labels, assignees and a truncated body.", inputs: "owner, repo, number", access: "read", status: "implemented" },
      { name: "github_list_pull_requests", summary: "Pull requests by state.", inputs: "owner, repo, state?, limit?, page?", access: "read", status: "implemented" },
      { name: "github_get_pull_request", summary: "One pull request with a capped changed-file summary.", inputs: "owner, repo, number", access: "read", status: "implemented" },
      { name: "github_list_commits", summary: "Commits of a branch.", inputs: "owner, repo, branch?, limit?, page?", access: "read", status: "implemented" },
      { name: "github_get_commit", summary: "One commit with a changed-file summary, no full patches.", inputs: "owner, repo, sha", access: "read", status: "implemented" },
      { name: "github_create_issue", summary: "Would create an issue.", inputs: "owner, repo, title, body?, labels?", access: "write", status: "not-shipped", note: "Planned after the MVP. Not registered." },
      { name: "github_add_issue_comment", summary: "Would add a comment to an issue.", inputs: "owner, repo, number, body", access: "write", status: "not-shipped", note: "Planned after the MVP. Not registered." },
    ],
  },
  {
    id: "api",
    title: "Custom API",
    blurb: "Call only the endpoints you described in config. No arbitrary URLs.",
    status: "implemented",
    statusNote: "Implemented and security-tested (QA passed for this pack). Write endpoints are denied unless explicitly allowed.",
    tools: [
      { name: "api_list_profiles", summary: "Configured API profiles. No secrets, no tokens.", inputs: "none", access: "read", status: "implemented" },
      { name: "api_get_endpoint_info", summary: "Method, path template, input schema and whether the endpoint is callable.", inputs: "profile, endpoint", access: "read", status: "implemented" },
      { name: "api_call_endpoint", summary: "Call a configured endpoint. Inputs validated, response truncated and redacted. Non-2xx responses are returned as data.", inputs: "profile, endpoint, pathParams?, query?, body?", access: "read", status: "implemented", note: "Write-method endpoints are denied unless writes are allowed for them." },
    ],
  },
  {
    id: "workspace",
    title: "Workflows",
    blurb: "Deterministic composite tools that combine the packs above. No model runs inside the server.",
    status: "implemented",
    statusNote: "Implemented and security-tested (QA passed for this pack). Each needs the packs it combines to be enabled.",
    tools: [
      { name: "workspace_get_overview", summary: "Project tree, notable files and, when enabled, repository, database and API status.", inputs: "workspace (and optional links)", access: "read", status: "implemented" },
      { name: "workspace_summarize_activity", summary: "Recent issues, pull requests and commits with counts. No ranking or judgment.", inputs: "repository", access: "read", status: "implemented" },
      { name: "workspace_find_issue_context", summary: "Issue facts plus files that match terms extracted from the issue, with the terms shown.", inputs: "repository, issue number, workspace", access: "read", status: "implemented" },
      { name: "workspace_inspect_data_flow", summary: "Where an API endpoint or database table is referenced in the code.", inputs: "workspace, profile or connection", access: "read", status: "implemented" },
      { name: "workspace_generate_change_plan", summary: "A templated checklist labelled proposed, not applied. Creates nothing.", inputs: "repository, issue number, workspace", access: "read", status: "implemented" },
    ],
  },
];

export const ERROR_CODES: { code: string; retryable: string; meaning: string }[] = [
  { code: "INVALID_INPUT", retryable: "No", meaning: "Input failed validation; the message names the field." },
  { code: "NOT_FOUND", retryable: "No", meaning: "Unknown workspace, connection, profile, endpoint, file or issue." },
  { code: "PERMISSION_DENIED", retryable: "No", meaning: "Outside the allowlist or root, blocked path, writes disabled, or method not allowed." },
  { code: "QUERY_REJECTED", retryable: "No", meaning: "SQL failed read-only validation." },
  { code: "UNSUPPORTED", retryable: "No", meaning: "For example a binary file, or EXPLAIN not supported by the adapter." },
  { code: "LIMIT_EXCEEDED", retryable: "No", meaning: "The request asks for more than a hard cap, or a result cannot be cut to fit the response budget." },
  { code: "INTEGRATION_DISABLED", retryable: "No", meaning: "The pack is disabled in config." },
  { code: "INTEGRATION_UNAVAILABLE", retryable: "Yes", meaning: "Database down, token missing for a private operation, or network unreachable." },
  { code: "TIMEOUT", retryable: "Yes", meaning: "The operation exceeded its time limit." },
  { code: "RATE_LIMITED", retryable: "Yes", meaning: "GitHub rate limit; includes a retry delay when known." },
  { code: "UPSTREAM_ERROR", retryable: "Maybe", meaning: "A transport failure or a GitHub non-success response, summarized safely." },
  { code: "INTERNAL_ERROR", retryable: "No", meaning: "Anything unexpected. Details stay in the local log, never in the result." },
];
