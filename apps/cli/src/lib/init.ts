// `tdk init` — scaffold a minimal TESTABLE template (template.ts, its scenarios
// fixture, tdk.config.ts) and write the first snapshot baseline. Pure in the lib
// sense: it writes the scaffold to disk and returns the created paths; it never
// prints or exits. `cli.ts` prints the `+ path` progress lines.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runTemplateTest, snapshotPath } from "./test.ts";

const INIT_TEMPLATE = `// A starter TDK template (scaffolded by \`tdk init\`), authored the AUTHORING-V2
// way (ADR-0025): FIELDS are module-scope consts, a \`derive\` computes a value from
// them, and an \`effect\` is the side-effectful submit step whose typed handle the
// template \`output\` reads. Edit the fields, the derive and the effect, then
// \`tdk test\` snapshot-asserts its behavior and \`tdk build\` compiles it for every
// target in tdk.config.ts.

import { defineTemplate, derive, effect, p, page } from "@tdk/core";

// --- Fields: module-scope consts (\`p.choice\` is the enum + labels sugar) --------
const flavor = p.choice(
  { vanilla: "Vanilla", chocolate: "Chocolate", "red-velvet": "Red velvet" },
  { title: "Flavor", required: true },
);
const size = p.choice(["small", "medium", "large"], { title: "Size", required: true });
const rush = p.boolean({ title: "Rush order?" });

// --- A derived value: computed at runtime from the fields (a jsonata step) -------
const orderSummary = derive("order-summary", { flavor, size }, (i) => \`\${i.size} \${i.flavor} cake\`);

// --- The effect: the side-effectful submit step, returning a typed handle --------
// In a real project a PACK publishes a typed helper for this action, so you write:
//
//   import { placeOrder } from "@your-org/bakery-pack";
//   const order = placeOrder("place-order", { summary: orderSummary, rush });
//
// Here we call core's \`effect(...)\` directly. \`<{ orderId: string }>\` declares the
// action's output shape, so \`order.output.orderId\` is a checked reference.
const order = effect<{ orderId: string }>("place-order", "bakery:place-order", {
  name: "Place the cake order",
  input: { summary: orderSummary, rush },
});

export default defineTemplate({
  id: "cake-order",
  title: "Cake Order",
  description: "Order a cake from the bakery",
  type: "service",
  // Pages are the ordered table of contents; each page's ui:order is inferred.
  pages: [page("Cake", { flavor, size }), page("Delivery", { rush })],
  // Effects are the reachability roots; the derive is pulled in through the effect.
  effects: [order],
  // Output reads the effect's output BY HANDLE — no hand-written step reference.
  output: { orderId: order.output.orderId },
});
`;

const INIT_SCENARIOS = `// Scenario fixtures for template.ts — each runs through execute() and is
// snapshot-asserted by \`tdk test\` (baseline in ../__snapshots__/scenarios.snap).

import type { ExecuteFixture } from "@tdk/core";

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<{ flavor: string; size: string; rush?: boolean }>;
}

export const scenarios: Scenario[] = [
  {
    name: "orders a large chocolate cake",
    fixture: {
      // The \`order-summary\` derive is computed for real; the \`place-order\` effect
      // is a non-jsonata action, so the scenario MOCKS its output.
      parameters: { flavor: "chocolate", size: "large", rush: true },
      steps: { "place-order": { output: { orderId: "ORD-1001" } } },
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
