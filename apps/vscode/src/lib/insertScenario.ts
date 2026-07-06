// PURE source transform: insert a new scenario entry into a template's
// `__fixtures__/scenarios.ts` — the "save form as scenario" reverse arrow (turn
// manually-filled form values into a committed fixture). Given the file's source
// text, a scenario name, and the form values, it returns the NEW source text (or
// `undefined` when the file shape is unrecognized, so the caller can fall back to
// an untitled snippet instead of corrupting the file).
//
// AST, NOT REGEX. We parse the file with the `typescript` compiler API and locate
// the `export const scenarios: … = [ … ]` array's closing bracket precisely — a
// regex over `]` would trip on a `]` inside a nested fixture value (an `items: [
// … ]` array, a `steps` map, a comment). We keep the rest of the file byte-for-byte
// and only splice the new element in before the array's final `]`, preserving the
// file's own indentation and trailing-comma style.

import * as ts from "typescript";

/** The formatted entry plus where to splice it — the internal plan the insert builds. */
interface InsertionPlan {
  /** Offset of the array literal's closing `]`. */
  closeBracket: number;
  /**
   * Offset to splice the new entry at: just past the last element AND its trailing
   * comma (if any). Content from here to `]` (a dangling comment, whitespace) is
   * preserved verbatim after the inserted entry.
   */
  insertAt: number;
  /** Whether the array already has at least one element. */
  hasElements: boolean;
  /** Whether the last element is already followed by a trailing comma. */
  trailingComma: boolean;
  /** The indent (spaces/tabs) one existing element sits at, e.g. "  ". */
  elementIndent: string;
}

/**
 * Insert a `{ name, fixture: { parameters } }` scenario into `source`'s exported
 * `scenarios` array, returning the new source. Returns `undefined` when the file
 * has no recognizable `export … scenarios = [ … ]` array literal (the caller then
 * offers the snippet in an untitled buffer — never a partial write).
 *
 * The new entry is pretty-printed with the file's detected indent unit, nested one
 * level under the array's element indent. A trailing comma is added to the previous
 * last element only if the file doesn't already use them (so both styles round-trip
 * cleanly).
 */
export function insertScenario(source: string, name: string, values: Record<string, unknown>): string | undefined {
  const array = findScenariosArray(source);
  if (!array) return undefined;

  const plan = planInsertion(source, array);
  const indentUnit = detectIndentUnit(source);
  const entry = formatScenarioEntry(name, values, plan.elementIndent, indentUnit);

  if (!plan.hasElements) {
    // Empty array `[]` (possibly `[\n]`, possibly holding a comment): keep whatever
    // sits between the brackets — a `// TODO` note must survive — then drop the
    // entry on its own line at element indent, close bracket at base indent.
    const baseIndent = plan.elementIndent.slice(0, Math.max(0, plan.elementIndent.length - indentUnit.length));
    const before = source.slice(0, array.openBracket + 1);
    const inner = source.slice(array.openBracket + 1, plan.closeBracket);
    const keep = inner.trim().length > 0 ? inner.replace(/\s+$/, "") : "";
    const after = source.slice(plan.closeBracket);
    return `${before}${keep}\n${plan.elementIndent}${entry},\n${baseIndent}${after}`;
  }

  // Splice at `insertAt` — the point just past the last element AND its trailing
  // comma (if any). Everything from there to `]` (whitespace, a dangling comment)
  // stays verbatim. We add the last element's comma ourselves only when the file
  // lacked one, so styles round-trip without ever doubling `,,`.
  const before = source.slice(0, plan.insertAt);
  const after = source.slice(plan.insertAt);
  const comma = plan.trailingComma ? "" : ",";
  return `${before}${comma}\n${plan.elementIndent}${entry},${after}`;
}

/** The located `scenarios` array literal: its `[`/`]` offsets and its elements. */
interface ScenariosArray {
  openBracket: number;
  closeBracket: number;
  elements: ts.NodeArray<ts.Expression>;
}

/**
 * Find the array literal initializer of an exported `scenarios` binding. Matches
 * `export const scenarios = [ … ]` (with or without a type annotation) and a plain
 * `export const scenarios: Scenario[] = [ … ]`. Returns `undefined` for any other
 * shape (a function call initializer, a spread, a non-array), so the caller falls
 * back rather than guessing.
 */
function findScenariosArray(source: string): ScenariosArray | undefined {
  const sf = ts.createSourceFile("scenarios.ts", source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  let found: ts.ArrayLiteralExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === "scenarios" &&
            decl.initializer &&
            ts.isArrayLiteralExpression(decl.initializer)
          ) {
            found = decl.initializer;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) return undefined;

  // `getStart`/`getEnd` give the bracket span; the array node's own end is just past `]`.
  const openBracket = found.getStart(sf);
  const closeBracket = found.getEnd() - 1;
  return { openBracket, closeBracket, elements: found.elements };
}

/** Build the splice plan (where + what style) from the located array. */
function planInsertion(source: string, array: ScenariosArray): InsertionPlan {
  const hasElements = array.elements.length > 0;
  if (!hasElements) {
    return {
      closeBracket: array.closeBracket,
      insertAt: array.openBracket + 1,
      hasElements: false,
      trailingComma: false,
      elementIndent: detectIndentUnit(source),
    };
  }

  const last = array.elements[array.elements.length - 1]!;
  const lastElementEnd = last.getEnd();
  // A trailing comma exists when the first non-TRIVIA token after the last element,
  // before the close bracket, is a comma — a COMMENT can sit between the element
  // and its comma (`} /* note */,`), which a whitespace regex would miss; adding
  // our own comma would then double it into `,,`, a legal ARRAY HOLE that silently
  // grows the array by two. Scan trivia-aware and splice AFTER the found comma so
  // it is never doubled; without one, splice right after the element (we add the
  // comma below).
  const tail = source.slice(lastElementEnd, array.closeBracket);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ true, ts.LanguageVariant.Standard, tail);
  const trailingComma = scanner.scan() === ts.SyntaxKind.CommaToken;
  const insertAt = trailingComma ? lastElementEnd + scanner.getTokenEnd() : lastElementEnd;
  const elementIndent = lineIndentOf(source, last.getStart());
  return { closeBracket: array.closeBracket, insertAt, hasElements: true, trailingComma, elementIndent };
}

/** The leading whitespace of the line an offset sits on (the element's indent). */
function lineIndentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const line = source.slice(lineStart, offset);
  const m = line.match(/^[ \t]*/);
  return m ? m[0] : "";
}

/**
 * Detect the file's indent unit: the smallest positive leading-whitespace run on
 * any line (tabs preferred if any line uses them). Defaults to two spaces when the
 * file offers no signal (a single-line array).
 */
function detectIndentUnit(source: string): string {
  const lines = source.split("\n");
  if (lines.some((l) => /^\t/.test(l))) return "\t";
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const m = line.match(/^( +)\S/);
    if (m) min = Math.min(min, m[1]!.length);
  }
  return Number.isFinite(min) && min > 0 ? " ".repeat(min) : "  ";
}

/**
 * Format ONE scenario object literal: `{ name: "…", fixture: { parameters: … } }`,
 * pretty-printed across lines at `indent` (the element indent) with `unit` as the
 * per-level step. Values are emitted as valid TS object/array literals via a small
 * JSON-ish printer (double-quoted keys only where needed, `undefined` preserved).
 */
function formatScenarioEntry(name: string, values: Record<string, unknown>, indent: string, unit: string): string {
  const i1 = indent + unit;
  const i2 = i1 + unit;
  // `printValue` uses its indent as the base for the value's OWN closing brace, so
  // pass i2 — the indent of the `parameters:` line — not i2+unit.
  const params = printValue(values, i2, unit);
  return [
    `{`,
    `${i1}name: ${quote(name)},`,
    `${i1}fixture: {`,
    `${i2}parameters: ${params},`,
    `${i1}},`,
    `${indent}}`,
  ].join("\n");
}

/** Double-quote a string with JSON escaping (safe for a TS string literal). */
function quote(s: string): string {
  return JSON.stringify(s);
}

/** An object key that's a valid bare identifier needs no quotes; otherwise quote it. */
function key(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quote(k);
}

/**
 * Pretty-print a JSON value as a TS literal at `indent`, stepping nested levels by
 * `unit`. Objects and arrays break across lines with a trailing comma per entry;
 * scalars stay inline. `undefined` prints literally (a form value can be cleared to
 * undefined); functions/symbols are dropped (they can't come from JSON form values).
 */
function printValue(value: unknown, indent: string, unit: string): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return quote(value as string);
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "function" || t === "symbol") return "undefined";

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + unit;
    const items = value.map((v) => `${inner}${printValue(v, inner, unit)},`);
    return `[\n${items.join("\n")}\n${indent}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => typeof v !== "function" && typeof v !== "symbol",
  );
  if (entries.length === 0) return "{}";
  const inner = indent + unit;
  const rows = entries.map(([k, v]) => `${inner}${key(k)}: ${printValue(v, inner, unit)},`);
  return `{\n${rows.join("\n")}\n${indent}}`;
}
