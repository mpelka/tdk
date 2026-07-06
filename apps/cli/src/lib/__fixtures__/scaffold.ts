// Shared scaffolding for the lib unit tests. A testable template dir must live
// INSIDE the package (a `.tmp-test-*` dir) so its `@tdk/core` imports resolve
// through the workspace's node_modules; the dot-prefix keeps it out of the
// `tdk test` discovery glob. This mirrors cli.test.ts's `pkgTmp` pattern.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/cli/src — the greeting fixture and package root are relative to this. */
export const SRC_DIR = join(here, "..", "..");
export const GREETING_DIR = join(SRC_DIR, "__fixtures__", "greeting");
export const GREETING_TEMPLATE = join(GREETING_DIR, "template.ts");
export const GREETING_SCENARIOS = join(GREETING_DIR, "__fixtures__", "scenarios.ts");
export const CONFIG = join(SRC_DIR, "__fixtures__", "tdk.config.ts");

/** Create a fresh in-package scratch dir (`.tmp-libtest-*`) — the caller cleans it. */
export function makePkgTmp(): Promise<string> {
  return mkdtemp(join(SRC_DIR, "..", ".tmp-libtest-"));
}

/**
 * Scaffold a testable template dir under `pkgTmp/name` — a copy of the greeting
 * fixture by default; `template`/`scenarios` override the file contents.
 */
export async function scaffoldTemplate(
  pkgTmp: string,
  name: string,
  opts: { template?: string; scenarios?: string } = {},
): Promise<string> {
  const dir = join(pkgTmp, name);
  await mkdir(join(dir, "__fixtures__"), { recursive: true });
  await writeFile(join(dir, "template.ts"), opts.template ?? (await readFile(GREETING_TEMPLATE, "utf8")), "utf8");
  await writeFile(
    join(dir, "__fixtures__", "scenarios.ts"),
    opts.scenarios ?? (await readFile(GREETING_SCENARIOS, "utf8")),
    "utf8",
  );
  return dir;
}

/**
 * A template carrying a LONG `jsonata(...)` expression baked into a
 * roadiehq:utils:jsonata step's \`expression:\` field. The author picks the
 * emission via the accessor: \`.jsonata\` is the pretty (multi-line) build-time
 * form, \`.compact\` the single-line one. (A JsonataExpr OBJECT dropped into a
 * \`${{ }}\` step-input value is rejected by compile — Backstage's \`${{ }}\` is
 * Nunjucks, not JSONata — so both fields here read a STRING accessor.)
 */
export const JSONATA_TEMPLATE = `import { defineTemplate, jsonata, nj, p, step } from "@tdk/core";

const payload = jsonata<{ who: string }>((c) => {
  const greeting = "Hello " + c.who + ", welcome to the bakery counter today";
  const label = c.who === "" ? "anonymous-order-ticket" : "personal-order-ticket";
  return { greeting: greeting, label: label };
});

export default defineTemplate({
  id: "jsonata-fixture",
  title: "Jsonata Fixture",
  description: "Pretty-print fixture",
  type: "service",
  parameters: { who: p.string({ title: "Who", required: true }) },
  steps: () => [
    step("compute", "roadiehq:utils:jsonata", {
      name: "Compute",
      input: {
        data: { who: nj((c) => c.parameters.who) },
        // .jsonata → the pretty (multi-line) build-time emission.
        expression: payload.jsonata,
      },
    }),
    step("compute-compact", "roadiehq:utils:jsonata", {
      name: "Compute (compact)",
      input: {
        data: { who: nj((c) => c.parameters.who) },
        // .compact → the canonical single-line emission.
        ticket: payload.compact,
      },
    }),
  ],
});
`;

/** A template whose compiled entity FAILS the Backstage schema (owner: 42). */
export const INVALID_TEMPLATE = `import { defineTemplate, p, step } from "@tdk/core";
export default defineTemplate({
  id: "bad-fixture",
  title: "Bad",
  description: "d",
  type: "service",
  parameters: { who: p.string({ title: "Who" }) },
  owner: 42 as unknown as string,
  steps: () => [step("greet", "debug:log", { name: "G", input: {} })],
});
`;
