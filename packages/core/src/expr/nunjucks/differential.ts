// The Nunjucks differential-test harness — the testability deliverable for `nj`.
//
// For each fixture it runs BOTH sides and asserts they agree:
//   - expected: the author's TS function evaluated in JS (the oracle),
//     coerced to how Nunjucks would stringify it;
//   - actual:   the compiled Nunjucks rendered with the real `nunjucks` library.
//
// Nunjucks always renders to a STRING, so the oracle value is scalarized the way
// Nunjucks would print it (`null`/`undefined` → "", booleans/numbers via
// `String`, arrays comma-joined, strings as-is). This lets a TS expression double
// as a test for its own compiled Nunjucks.

import nunjucks from "nunjucks";
import type { NunjucksExpr } from "./index.ts";

/** A render environment with autoescape OFF, matching Backstage Scaffolder. */
const env = new nunjucks.Environment(undefined, { autoescape: false });

/** Render a compiled Nunjucks expression against a fixture (Scaffolder-style). */
export function renderNj(expression: string, fixture: unknown): string {
  return env.renderString(`{{ ${expression} }}`, (fixture ?? {}) as object);
}

/**
 * Coerce a JS oracle value to the string Nunjucks would emit for it:
 *   - `null` / `undefined` → "" (Nunjucks prints nothing),
 *   - everything else via `String(...)` (booleans, numbers, comma-joined arrays,
 *     and `[object Object]` for objects — all matching Nunjucks output).
 */
export function njString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Outcome for a single fixture in a Nunjucks differential run. */
export interface NjDifferentialCase<F = unknown> {
  fixture: F;
  expected: string;
  actual: string;
  equal: boolean;
}

/** Aggregate result of a Nunjucks differential run. */
export interface NjDifferentialResult<F = unknown> {
  ok: boolean;
  cases: NjDifferentialCase<F>[];
  mismatches: number[];
}

/**
 * Run `njFn` (a `NunjucksExpr` from `nj(...)`) against each fixture, comparing the
 * scalarized JS oracle to the rendered Nunjucks. Returns a structured result;
 * nothing is thrown for a mismatch (use `assertDifferentialNj` for that).
 */
export function differentialNj<Ctx, R>(njFn: NunjucksExpr<Ctx, R>, fixtures: Ctx[]): NjDifferentialResult<Ctx> {
  const cases: NjDifferentialCase<Ctx>[] = [];
  const mismatches: number[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    let expected: string;
    try {
      expected = njString(njFn.fn(fixture));
    } catch (err) {
      expected = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // Symmetric with the oracle side: a render throw becomes a comparable
    // outcome instead of crashing the whole harness.
    let actual: string;
    try {
      actual = renderNj(njFn.nunjucks, fixture);
    } catch (err) {
      actual = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    const equal = expected === actual;
    if (!equal) mismatches.push(i);
    cases.push({ fixture, expected, actual, equal });
  }

  return { ok: mismatches.length === 0, cases, mismatches };
}

/**
 * Like `differentialNj`, but throws a detailed error listing every mismatching
 * fixture. Intended to be called directly from a test body.
 */
export function assertDifferentialNj<Ctx, R>(njFn: NunjucksExpr<Ctx, R>, fixtures: Ctx[]): void {
  const result = differentialNj(njFn, fixtures);
  if (result.ok) return;
  const detail = result.mismatches
    .map((i) => {
      const c = result.cases[i]!;
      return (
        `  fixture[${i}] = ${json(c.fixture)}\n` +
        `    expected: ${JSON.stringify(c.expected)}\n` +
        `    actual:   ${JSON.stringify(c.actual)}`
      );
    })
    .join("\n");
  throw new Error(
    `differentialNj: ${result.mismatches.length}/${result.cases.length} ` +
      `fixture(s) disagreed for Nunjucks:\n  ${njFn.nunjucks}\n${detail}`,
  );
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
