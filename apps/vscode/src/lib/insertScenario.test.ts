// Heavy unit tests for the PURE scenario-insertion transform. It must handle an
// empty array, a trailing comma, comments, nested fixtures, and — the acid test —
// the real example `scenarios.ts` files verbatim, always producing source that
// still PARSES and whose `scenarios` array grew by exactly one well-formed entry.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { insertScenario } from "./insertScenario.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

/** Assert `source` parses with zero syntactic diagnostics. */
function parses(source: string): boolean {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  // `parseDiagnostics` is internal but the reliable syntax-error signal.
  const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  return diags.length === 0;
}

/**
 * Recover the exported `scenarios` array's element count from source (via the AST),
 * so a test can assert it grew by one without depending on formatting.
 */
function scenarioCount(source: string): number {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  let count = -1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "scenarios" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      count = node.initializer.elements.length;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

/** The parsed first/last element's `name` property text, for order assertions. */
function scenarioNames(source: string): string[] {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "scenarios" &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const el of node.initializer.elements) {
        if (ts.isObjectLiteralExpression(el)) {
          for (const prop of el.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "name" &&
              ts.isStringLiteral(prop.initializer)
            ) {
              names.push(prop.initializer.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

describe("insertScenario — the pure save-as-scenario transform", () => {
  test("inserts into an empty array literal and the result parses", () => {
    const src = `export const scenarios = [];\n`;
    const out = insertScenario(src, "first", { who: "Ada" });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(1);
    expect(scenarioNames(out!)).toEqual(["first"]);
    expect(out!).toContain(`who: "Ada"`);
  });

  test("inserts into an empty multi-line array literal", () => {
    const src = `export const scenarios = [\n];\n`;
    const out = insertScenario(src, "first", { a: 1 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(1);
  });

  test("appends after an existing element WITHOUT a trailing comma (adds one)", () => {
    const src = [
      `export const scenarios = [`,
      `  {`,
      `    name: "one",`,
      `    fixture: { parameters: { x: 1 } },`,
      `  }`, // no trailing comma
      `];`,
      ``,
    ].join("\n");
    const out = insertScenario(src, "two", { x: 2 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    expect(scenarioNames(out!)).toEqual(["one", "two"]);
  });

  test("appends after an existing element WITH a trailing comma (keeps style)", () => {
    const src = [
      `export const scenarios = [`,
      `  {`,
      `    name: "one",`,
      `    fixture: { parameters: { x: 1 } },`,
      `  },`, // trailing comma present
      `];`,
      ``,
    ].join("\n");
    const out = insertScenario(src, "two", { x: 2 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    // The original element's single trailing comma is not doubled.
    expect(out!).not.toContain(",,");
  });

  test("preserves a comment INSIDE the array (doesn't splice inside it)", () => {
    const src = [
      `export const scenarios = [`,
      `  {`,
      `    // a leading comment on the element`,
      `    name: "one",`,
      `    fixture: { parameters: { x: 1 } },`,
      `  },`,
      `  // a dangling comment before the close bracket`,
      `];`,
      ``,
    ].join("\n");
    const out = insertScenario(src, "two", { x: 2 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    expect(out!).toContain("a leading comment on the element");
    expect(out!).toContain("a dangling comment before the close bracket");
  });

  test("handles a `] as const` / trailing content after the close bracket", () => {
    const src = `export const scenarios = [\n  { name: "one", fixture: { parameters: {} } },\n];\nconst other = 1;\n`;
    const out = insertScenario(src, "two", {});
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    expect(out!).toContain("const other = 1;");
  });

  test("pretty-prints a NESTED fixture value (arrays + objects) as valid TS", () => {
    const src = `export const scenarios: Scenario[] = [];\n`;
    const out = insertScenario(src, "nested", {
      customerName: "Bob",
      items: [{ sku: "CAKE-2", qty: 1, options: ["chocolate"], unitPrice: 8 }],
      priority: "normal",
    });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(out!).toContain(`sku: "CAKE-2"`);
    expect(out!).toContain(`options: [`);
  });

  test("keeps a bare identifier key unquoted but quotes a non-identifier key", () => {
    const src = `export const scenarios = [];\n`;
    const out = insertScenario(src, "keys", { fetchBaker: 1, "kebab-key": 2 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(out!).toContain("fetchBaker: 1");
    expect(out!).toContain(`"kebab-key": 2`);
  });

  test("respects a tab-indented file", () => {
    const src = `export const scenarios = [\n\t{\n\t\tname: "one",\n\t\tfixture: { parameters: {} },\n\t},\n];\n`;
    const out = insertScenario(src, "two", { a: 1 });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    // The inserted element line uses a tab indent, matching the file.
    expect(out!).toMatch(/\n\t\{\n\t\tname: "two"/);
  });

  test("escapes a name with quotes / special chars", () => {
    const src = `export const scenarios = [];\n`;
    const out = insertScenario(src, 'a "quoted" name', {});
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioNames(out!)).toEqual(['a "quoted" name']);
  });

  test("returns undefined when there is no exported scenarios array (fallback signal)", () => {
    expect(insertScenario(`const scenarios = [];\n`, "x", {})).toBeUndefined(); // not exported
    expect(insertScenario(`export const other = [];\n`, "x", {})).toBeUndefined(); // wrong name
    expect(insertScenario(`export const scenarios = makeScenarios();\n`, "x", {})).toBeUndefined(); // not a literal
    expect(insertScenario(`// just a comment\n`, "x", {})).toBeUndefined();
  });

  test("preserves null and undefined form values", () => {
    const src = `export const scenarios = [];\n`;
    const out = insertScenario(src, "nullish", { a: null, b: undefined });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(out!).toContain("a: null");
    expect(out!).toContain("b: undefined");
  });
});

// The acid test: every real example scenarios.ts, verbatim, grows by exactly one
// parseable scenario. This is the shape the extension actually edits in the wild.
describe("insertScenario — real example files verbatim", () => {
  const examples = ["conditional-forms", "env-loaded", "fallback-chains", "payload-assembly", "plugin-composed"];

  for (const name of examples) {
    test(`${name}/__fixtures__/scenarios.ts grows by one and still parses`, () => {
      const path = join(repoRoot, "examples", name, "__fixtures__", "scenarios.ts");
      const src = readFileSync(path, "utf8");
      const before = scenarioCount(src);
      const out = insertScenario(src, "saved from the form preview", { orderType: "standard", station: "pastry" });
      expect(out).toBeDefined();
      expect(parses(out!)).toBe(true);
      expect(scenarioCount(out!)).toBe(before + 1);
      // The new entry is the LAST one.
      expect(scenarioNames(out!).at(-1)).toBe("saved from the form preview");
    });
  }
});

describe("insertScenario — verifier regressions (comment-adjacent commas, empty-array trivia)", () => {
  // A comment BETWEEN the last element and its trailing comma defeated the old
  // whitespace-regex comma detection: the transform added its own comma, doubling
  // it into `,,` — a legal ARRAY HOLE that silently grew the array by TWO (one
  // being `undefined`). The trivia-aware scan must splice after the real comma.
  test("a block comment between the last element and its trailing comma", () => {
    const src = `export const scenarios = [\n  { name: "a", fixture: { parameters: {} } } /* note */,\n];\n`;
    const out = insertScenario(src, "b", { flavor: "rye" });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    expect(out!).not.toContain(",,");
    expect(out!).toContain("/* note */");
  });

  test("a line comment between the last element and its trailing comma", () => {
    const src = `export const scenarios = [\n  { name: "a", fixture: { parameters: {} } } // note\n  ,\n];\n`;
    const out = insertScenario(src, "b", { flavor: "rye" });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(2);
    expect(out!).not.toContain(",,");
    expect(out!).toContain("// note");
  });

  // The old empty-array branch discarded everything between `[` and `]` — a
  // placeholder comment was silently lost. Inner trivia must survive the insert.
  test("a comment inside an otherwise-empty array is preserved", () => {
    const src = `export const scenarios = [\n  // TODO: add scenarios\n];\n`;
    const out = insertScenario(src, "first", { flavor: "rye" });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    expect(scenarioCount(out!)).toBe(1);
    expect(out!).toContain("// TODO: add scenarios");
  });

  test("the entry inserted into an empty array is indented, not at column 0", () => {
    const src = `export const scenarios = [];\n`;
    const out = insertScenario(src, "first", { flavor: "rye" });
    expect(out).toBeDefined();
    expect(parses(out!)).toBe(true);
    // The opening brace of the new entry sits on its own INDENTED line.
    expect(out!).toMatch(/\n[ \t]+\{\n/);
  });
});
