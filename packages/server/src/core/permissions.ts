/** Pure permission decisions per doc 03 section 4 (D7). Deny by default. */
export interface PermissionsConfig {
  allowWrites: boolean;
  /** Exact tool names, or `api:<profile>/<endpoint>`. */
  writeOperations: readonly string[];
}

/** Read-only default (PRD 11.1). */
export const DEFAULT_PERMISSIONS: Readonly<PermissionsConfig> = Object.freeze({
  allowWrites: false,
  writeOperations: Object.freeze([] as string[]),
});

export interface ToolPolicy {
  name: string;
  write: boolean;
  /** Whether the owning pack is enabled. */
  packEnabled: boolean;
}

/** Read access: the resource must be exactly in the configured allowlist. */
export function canRead(allowlist: readonly string[], resource: string): boolean {
  return allowlist.includes(resource);
}

/** Write access needs allowWrites === true AND exact operation match AND pack enabled. */
export function canWrite(
  permissions: Partial<PermissionsConfig> | undefined,
  operation: string,
  packEnabled: boolean,
): boolean {
  if (permissions?.allowWrites !== true) return false;
  if (!packEnabled) return false;
  return (permissions.writeOperations ?? []).includes(operation);
}

export function isRegistered(
  permissions: Partial<PermissionsConfig> | undefined,
  tool: ToolPolicy,
): boolean {
  if (!tool.packEnabled) return false;
  return tool.write ? canWrite(permissions, tool.name, tool.packEnabled) : true;
}
