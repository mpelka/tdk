// `tdk init` — scaffold a minimal TESTABLE template (template.ts, its scenarios
// fixture, tdk.config.ts) and write the first snapshot baseline. Pure in the lib
// sense: it writes the scaffold to disk and returns the created paths; it never
// prints or exits. `cli.ts` prints the `+ path` progress lines.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runTemplateTest, snapshotPath } from "./test.ts";

const INIT_TEMPLATE = `// A starter TDK template (scaffolded by \`tdk init\`). Edit the parameters and
// steps, then \`tdk test\` snapshot-asserts its behavior and \`tdk build\`
// compiles it for every target in tdk.config.ts.

import { defineTemplate, env, p, raw, step } from "@tdk/core";

export default defineTemplate({
  id: "cake-order",
  title: "Cake Order",
  description: "Order a cake from the bakery",
  type: "service",
  parameters: {
    flavor: p.string({ title: "Flavor", required: true }),
  },
  steps: (f) => [
    step("bake", "debug:log", {
      name: "Bake the cake",
      input: {
        oven: env.pick({ test: "test-oven", prod: "prod-oven" }),
        message: raw\`Baking a \${f.flavor} cake!\`,
      },
    }),
  ],
});
`;

const INIT_SCENARIOS = `// Scenario fixtures for template.ts — each runs through execute() and is
// snapshot-asserted by \`tdk test\` (baseline in ../__snapshots__/scenarios.snap).

import type { ExecuteFixture } from "@tdk/core";

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<{ flavor: string }>;
}

export const scenarios: Scenario[] = [
  {
    name: "orders a chocolate cake",
    fixture: {
      parameters: { flavor: "chocolate" },
      steps: { bake: { output: {} } },
    },
  },
];
`;

const INIT_CONFIG = `// TDK project config — \`tdk build\` compiles every template × target to YAML.
// Output paths are relative to THIS file.

import { defineConfig } from "@tdk/core";
import CakeOrder from "./template.ts";

export default defineConfig({
  templates: [CakeOrder],
  targets: {
    nonprod: { env: "test", outDir: "./dist/nonprod" },
    prod: { env: "prod", outDir: "./dist/prod" },
  },
});
`;

/** The paths a successful `init` created — for the caller to print. */
export interface InitResult {
  /** The resolved target directory. */
  dir: string;
  /** The scaffolded source files, in write order. */
  files: string[];
  /** The first-baseline snapshot path. */
  snapshot: string;
}

/**
 * Scaffold a minimal TESTABLE template into `dir` (default `.`) — `template.ts`,
 * `__fixtures__/scenarios.ts` and `tdk.config.ts` — then run the scenario engine
 * once to write the first snapshot baseline (`__snapshots__/scenarios.snap`).
 * Refuses to overwrite any existing file (throws). Throws if the scaffolded
 * template fails its first run. Returns the created paths; nothing is printed.
 */
export async function runInit(dirArg: string | undefined): Promise<InitResult> {
  const dir = resolve(dirArg ?? ".");
  const files: Array<[string, string]> = [
    [join(dir, "template.ts"), INIT_TEMPLATE],
    [join(dir, "__fixtures__", "scenarios.ts"), INIT_SCENARIOS],
    [join(dir, "tdk.config.ts"), INIT_CONFIG],
  ];

  const existing: string[] = [];
  for (const [path] of files) {
    if (await Bun.file(path).exists()) existing.push(path);
  }
  if (existing.length) {
    throw new Error(`tdk init: refusing to overwrite existing file(s):\n${existing.map((f) => `  ${f}`).join("\n")}`);
  }

  const written: string[] = [];
  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    written.push(path);
  }

  // Write the first snapshot baseline — the equivalent of `tdk test <dir>`.
  const report = await runTemplateTest(join(dir, "template.ts"), dir, { update: false, ci: false });
  if (!report.ok || report.scenarios.some((s) => s.status === "failed")) {
    throw new Error(`tdk init: the scaffolded template failed its first run:\n${report.error ?? "scenario failure"}`);
  }

  return { dir, files: written, snapshot: snapshotPath(join(dir, "template.ts")) };
}
