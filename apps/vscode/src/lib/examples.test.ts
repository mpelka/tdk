// Integration test: compile ALL FIVE gold-standard examples through the REAL CLI,
// parse the YAML, and run each's `spec.parameters` through the pages/uiSchema
// pipeline — asserting it produces valid `{ schema, uiSchema }` pages WITHOUT
// throwing. This is the end-to-end guard that the splitter survives every shape
// TDK actually emits (single page, multi-page wizard, arrays, conditionals,
// custom `ui:field`), not just the hand-written unit cases.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { toFormPages } from "./pages.ts";

// This file lives at apps/vscode/src/lib — the repo root is four levels up.
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const cli = join(repoRoot, "apps", "cli", "src", "cli.ts");

const EXAMPLES = ["conditional-forms", "env-loaded", "fallback-chains", "payload-assembly", "plugin-composed"];

/** Compile one example via `bun run cli.ts compile <template>` and return its YAML. */
function compileExample(name: string): string {
  const template = join(repoRoot, "examples", name, "template.ts");
  const result = spawnSync("bun", ["run", cli, "compile", template], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`compile ${name} failed (code ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

/** Every `ui:*` key must be GONE from the split schema (walk it recursively). */
function assertNoUiKeys(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) assertNoUiKeys(entry);
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      expect(key.startsWith("ui:")).toBe(false);
      assertNoUiKeys(value);
    }
  }
}

describe("examples — real compiled parameters through the splitter", () => {
  // Guard: if the CLI moved, fail loudly rather than silently skipping.
  test("the CLI entrypoint exists", () => {
    expect(existsSync(cli)).toBe(true);
  });

  for (const name of EXAMPLES) {
    test(`${name}: splits into valid { schema, uiSchema } pages without throwing`, () => {
      const yaml = compileExample(name);
      const doc = parseYaml(yaml) as { spec?: { parameters?: unknown } };
      const pages = toFormPages(doc.spec?.parameters);

      expect(pages.length).toBeGreaterThan(0);
      for (const page of pages) {
        expect(page.schema).toBeDefined();
        expect(typeof page.schema).toBe("object");
        expect(page.uiSchema).toBeDefined();
        expect(typeof page.uiSchema).toBe("object");
        // The split schema must be free of any embedded `ui:*` hints.
        assertNoUiKeys(page.schema);
      }
    });
  }

  test("conditional-forms: multi-page, and a revealed field's ui:widget merges up", () => {
    const yaml = compileExample("conditional-forms");
    const doc = parseYaml(yaml) as { spec?: { parameters?: unknown } };
    const pages = toFormPages(doc.spec?.parameters);
    // Four pages: Order Type, Packaging & Speed, Baker Notes, Delivery.
    expect(pages.length).toBe(4);
    expect(pages.map((p) => p.title)).toEqual(["Order Type", "Packaging & Speed", "Baker Notes", "Delivery"]);
    // The Baker Notes page has bakerNotes with ui:widget: textarea, lifted out.
    const bakerNotes = pages[2]!;
    expect(bakerNotes.uiSchema).toMatchObject({ bakerNotes: { "ui:widget": "textarea" } });
  });

  test("plugin-composed: a custom ui:field + ui:options are lifted into the uiSchema", () => {
    const yaml = compileExample("plugin-composed");
    const doc = parseYaml(yaml) as { spec?: { parameters?: unknown } };
    const pages = toFormPages(doc.spec?.parameters);
    // Single page — normalized to one entry.
    expect(pages.length).toBe(1);
    expect(pages[0]!.uiSchema).toMatchObject({
      ovenModel: {
        "ui:field": "CakePickerWithDefault",
        "ui:options": { path: "bakery/oven-models", default: "deck-3000" },
      },
    });
  });

  test("payload-assembly: nested array items split cleanly (no throw, single page)", () => {
    const yaml = compileExample("payload-assembly");
    const doc = parseYaml(yaml) as { spec?: { parameters?: unknown } };
    const pages = toFormPages(doc.spec?.parameters);
    expect(pages.length).toBe(1);
    const items = (pages[0]!.schema.properties as any).items;
    expect(items.type).toBe("array");
    expect(items.items.properties.sku).toEqual({ type: "string" });
  });
});
