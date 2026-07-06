// Where is the `tdk` binary? Pure resolution logic (no vscode import) so the
// chain is unit-testable. `spawnTdk` feeds it the real fs/env/config.

import * as path from "node:path";

export interface ResolveCliInput {
  /** The workspace folder the template lives in. */
  workspaceRoot: string;
  /** The `tdk.cliPath` setting — an absolute path; empty/undefined when unset. */
  cliPathSetting?: string;
  /** The extension host's PATH entries, already split on the platform delimiter. */
  pathDirs: string[];
  /** The user's home directory — for the well-known `~/.bun/bin/tdk` global link. */
  home?: string;
  /** Injectable existence check (`fs.existsSync` in production). */
  exists: (p: string) => boolean;
}

export interface ResolvedCli {
  bin: string;
  /** Which rung of the chain matched — surfaced in logs and error messages. */
  source: "setting" | "workspace" | "path" | "bun-global";
}

/**
 * Resolve the `tdk` binary, first match wins:
 *
 *   1. the `tdk.cliPath` setting — an explicit user override beats discovery
 *   2. the workspace's own `node_modules/.bin/tdk` — the preferred default: the
 *      CLI and the template resolve ONE `@tdk/core` copy, keeping the DSL's
 *      `instanceof` / module-identity checks intact
 *   3. a `tdk` executable on the extension host's PATH
 *   4. `~/.bun/bin/tdk` — where `bun link` puts a globally linked CLI (GUI-launched
 *      VS Code often misses that PATH entry, so probe it explicitly)
 *
 * A global CLI (3/4) compiles templates whose imports still resolve from the
 * TEMPLATE's workspace — correct whenever both link the same TDK source, which is
 * the working-on-TDK-itself and bun-linked-consumer setup.
 */
export function resolveTdkBin(input: ResolveCliInput): ResolvedCli | undefined {
  if (input.cliPathSetting && input.exists(input.cliPathSetting)) {
    return { bin: input.cliPathSetting, source: "setting" };
  }
  const workspaceBin = path.join(input.workspaceRoot, "node_modules", ".bin", "tdk");
  if (input.exists(workspaceBin)) {
    return { bin: workspaceBin, source: "workspace" };
  }
  for (const dir of input.pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, "tdk");
    if (input.exists(candidate)) return { bin: candidate, source: "path" };
  }
  if (input.home) {
    const bunGlobal = path.join(input.home, ".bun", "bin", "tdk");
    if (input.exists(bunGlobal)) return { bin: bunGlobal, source: "bun-global" };
  }
  return undefined;
}

/** The actionable not-found message, naming every searched location. */
export function cliNotFoundMessage(workspaceRoot: string): string {
  return (
    `TDK CLI not found. Searched: the tdk.cliPath setting, ` +
    `${path.join(workspaceRoot, "node_modules", ".bin", "tdk")}, PATH, and ~/.bun/bin/tdk. ` +
    `Fix: add @tdk/cli to the workspace and run \`bun install\`, or link it globally ` +
    `(\`bun link\` in the CLI package), or set tdk.cliPath.`
  );
}
