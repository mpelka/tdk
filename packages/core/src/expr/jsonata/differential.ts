// The differential-test harness — the core testability deliverable.
//
// For each fixture it runs BOTH sides and asserts they agree:
//   - expected: the author's TS function evaluated in JS (the oracle),
//   - actual:   the compiled JSONata evaluated via the `jsonata` library.
//
// This is what lets a TS expression double as a test for its own compiled
// JSONata. Export it so authors can drop it into their `bun:test` files.
//
// Agreement is THROW-AWARE: a procedural expression may `assert(...)` and abort.
// Two evaluations agree when they BOTH produced deep-equal values, OR they BOTH
// threw with the SAME message. A throw never agrees with a value. This makes the
// `$assert`/`assert` guard cases first-class differential fixtures.

import jsonata from "jsonata";
import type { JsonataExpr } from "./index.ts";

/** Outcome for a single fixture in a differential run. */
export interface DifferentialCase<F = unknown> {
  fixture: F;
  /** The reference/expected side's value, or `Error: <message>` if it threw. */
  expected: unknown;
  /** The compiled/actual side's value, or `Error: <message>` if it threw. */
  actual: unknown;
  equal: boolean;
}

/** Aggregate result of a differential run. */
export interface DifferentialResult<F = unknown> {
  ok: boolean;
  cases: DifferentialCase<F>[];
  /** Indices of fixtures where the two sides disagreed. */
  mismatches: number[];
}

/** A single evaluation outcome: a produced value, or a thrown error's message. */
type Outcome = { thrown: false; value: unknown } | { thrown: true; message: string };

/**
 * Extract a comparable message from a thrown value. JS oracles throw real
 * `Error`s; JSONata's engine throws a PLAIN object `{ code, message, ... }`
 * (not an `Error` instance), so we read `.message` off both. This is what lets
 * a JS `assert(cond, msg)` throw agree with a JSONata `$assert(cond, msg)` throw
 * — both carry the same `msg`.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Evaluate the JS oracle, capturing a thrown Error as an outcome. */
function evalJs<Ctx, R>(fn: (ctx: Ctx) => R, fixture: Ctx): Outcome {
  try {
    return { thrown: false, value: fn(fixture) };
  } catch (err) {
    return { thrown: true, message: errMessage(err) };
  }
}

/** Evaluate a JSONata string against a fixture, capturing a throw as an outcome. */
async function evalJsonata(str: string, fixture: unknown): Promise<Outcome> {
  try {
    const value = await jsonata(str).evaluate(fixture as object);
    return { thrown: false, value };
  } catch (err) {
    return { thrown: true, message: errMessage(err) };
  }
}

/** Two outcomes agree iff both threw the same message, or both have equal values. */
function outcomesAgree(a: Outcome, b: Outcome): boolean {
  if (a.thrown || b.thrown) {
    return a.thrown && b.thrown && a.message === b.message;
  }
  return deepEqual(normalize(a.value), normalize(b.value));
}

/** The reportable form of an outcome for diagnostics. */
function report(o: Outcome): unknown {
  return o.thrown ? `Error: ${o.message}` : o.value;
}

/** Options for `differential` / `assertDifferential`. */
export interface DifferentialOptions {
  /**
   * Treat a JS-side NaN as the MISSING value before comparing. JS `NaN` has no
   * JSONata representation, so the `parseInt`/`parseFloat` shims yield missing
   * where JS yields NaN — a DOCUMENTED agreement (expression-support.md) that
   * this flag encodes for those two functions ONLY. Everywhere else a NaN must
   * stay a loud mismatch (see the normalize() marker).
   */
  nanIsMissing?: boolean;
}

/**
 * Run `exprFn` (a `JsonataExpr` from `jsonata(...)`) against each fixture, comparing
 * the JS oracle to the compiled JSONata. Returns a structured result; nothing is
 * thrown for a mismatch (use `assertDifferential` for that).
 *
 * JSONata evaluation is async, so this returns a Promise.
 */
export async function differential<Ctx, R>(
  exprFn: JsonataExpr<Ctx, R>,
  fixtures: Ctx[],
  opts: DifferentialOptions = {},
): Promise<DifferentialResult<Ctx>> {
  const cases: DifferentialCase<Ctx>[] = [];
  const mismatches: number[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    let js = evalJs(exprFn.fn, fixture);
    if (opts.nanIsMissing && !js.thrown && typeof js.value === "number" && Number.isNaN(js.value)) {
      js = { thrown: false, value: undefined };
    }
    const jn = await evalJsonata(exprFn.jsonata, fixture);
    const equal = outcomesAgree(js, jn);
    if (!equal) mismatches.push(i);
    cases.push({ fixture, expected: report(js), actual: report(jn), equal });
  }

  return { ok: mismatches.length === 0, cases, mismatches };
}

/**
 * Like `differential`, but compares the compiled JSONata against a REFERENCE
 * JSONata string (e.g. the ORIGINAL hand-written expression from a gold-standard
 * file) instead of the JS oracle. This proves the transpiler reproduces an
 * existing expression EXACTLY — value-for-value and throw-for-throw — on every
 * fixture.
 */
export async function differentialJsonata<Ctx>(
  exprFn: JsonataExpr<Ctx, unknown>,
  referenceJsonata: string,
  fixtures: Ctx[],
): Promise<DifferentialResult<Ctx>> {
  const cases: DifferentialCase<Ctx>[] = [];
  const mismatches: number[] = [];

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    const mine = await evalJsonata(exprFn.jsonata, fixture);
    const ref = await evalJsonata(referenceJsonata, fixture);
    const equal = outcomesAgree(mine, ref);
    if (!equal) mismatches.push(i);
    cases.push({ fixture, expected: report(ref), actual: report(mine), equal });
  }

  return { ok: mismatches.length === 0, cases, mismatches };
}

/**
 * Like `differential`, but throws a detailed error listing every mismatching
 * fixture. Intended to be called directly from a test body.
 */
export async function assertDifferential<Ctx, R>(
  exprFn: JsonataExpr<Ctx, R>,
  fixtures: Ctx[],
  opts: DifferentialOptions = {},
): Promise<void> {
  throwOnMismatch(await differential(exprFn, fixtures, opts), exprFn.jsonata);
}

/**
 * Like `differentialJsonata`, but throws a detailed error on any disagreement
 * between the compiled JSONata and the reference JSONata.
 */
export async function assertDifferentialJsonata<Ctx>(
  exprFn: JsonataExpr<Ctx, unknown>,
  referenceJsonata: string,
  fixtures: Ctx[],
): Promise<void> {
  throwOnMismatch(await differentialJsonata(exprFn, referenceJsonata, fixtures), exprFn.jsonata);
}

function throwOnMismatch(result: DifferentialResult, jsonataStr: string): void {
  if (result.ok) return;
  const detail = result.mismatches
    .map((i) => {
      const c = result.cases[i]!;
      return (
        `  fixture[${i}] = ${json(c.fixture)}\n` +
        `    expected: ${json(c.expected)}\n` +
        `    actual:   ${json(c.actual)}`
      );
    })
    .join("\n");
  throw new Error(
    `differential: ${result.mismatches.length}/${result.cases.length} ` +
      `fixture(s) disagreed for JSONata:\n  ${jsonataStr}\n${detail}`,
  );
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Normalize a value for comparison. JSONata returns `undefined` for "no match"
 * where JS may also return `undefined`; JSON round-tripping drops `undefined`
 * object members on both sides, giving a consistent basis for deep-equality.
 *
 * NaN/Infinity are recorded as DISTINGUISHABLE marker strings first — a plain
 * JSON round-trip would fold them to `null` and silently mask a disagreement
 * (e.g. a JS oracle producing NaN "agreeing" with a JSONata null).
 */
function normalize(v: unknown): unknown {
  if (v === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(v ?? null, (_key, value) =>
      typeof value === "number" && !Number.isFinite(value) ? `__tdk_non_finite__:${String(value)}` : value,
    ),
  );
}

/** Structural deep-equality on JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
