// Compile a real gold-standard example through the REAL `tdk` CLI and split it into
// the `FormPage[]` the webview renders — the same path `examples.test.ts` uses, so
// the webview tests feed on the EXACT payload the extension pushes in production
// (no hand-mocked schema). Shared by both the App component tests (layer 1) and the
// built-bundle smoke test (layer 2).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { toFormPages } from "../lib/pages.ts";
import type { FormPage } from "../webview/protocol.ts";

// This module lives at apps/vscode/src/test — the repo root is four levels up.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const cli = join(repoRoot, "apps", "cli", "src", "cli.ts");

/** Compile one example via `bun run cli.ts compile <template>` and return its YAML. */
export function compileExampleYaml(name: string): string {
  const template = join(repoRoot, "examples", name, "template.ts");
  const result = spawnSync("bun", ["run", cli, "compile", template], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`compile ${name} failed (code ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

/** Compile an example and split its `spec.parameters` into the webview's `FormPage[]`. */
export function exampleFormPages(name: string): FormPage[] {
  const doc = parseYaml(compileExampleYaml(name)) as { spec?: { parameters?: unknown } };
  return toFormPages(doc.spec?.parameters);
}
