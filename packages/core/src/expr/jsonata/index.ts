// The `jsonata` API — the TS→JSONata transpiler surface authors import.
//
// `jsonata<Ctx>((c) => <body>)` transpiles the arrow's body to a JSONata string
// at authoring/build time and returns a value usable anywhere a `raw` expression
// is (step input, output, `if`). Compile wraps it in `${{ ... }}` so the
// Scaffolder evaluates the JSONata at runtime.
//
// Every compiled string is VALIDATED by parsing it with `jsonataLib(str)` — if
// our transpiler produced something the engine can't parse, we throw with the
// offending string rather than emit garbage.
//
// NOTE: this module imports BOTH the `jsonata` npm library (for parse-validation)
// AND defines the TDK builder named `jsonata`. To avoid the collision the library
// is aliased here as `jsonataLib`.

import jsonataLib from "jsonata";
import type { RawRef, RefResolver } from "../index.ts";
import { formatJsonata } from "./format.ts";
import { quote, TranspileError, transpileArrowSource } from "./transpile.ts";

export { formatJsonata, TranspileError };

/**
 * A compiled JSONata expression. Like `RawExpr`, it renders to a Scaffolder
 * expression string at compile — here `${{ <jsonata> }}`. It also exposes the
 * compiled JSONata (`.jsonata`) and the original JS function (`.fn`) so the
 * differential harness can run both sides.
 *
 * `.jsonata` is the PRETTY-FORMATTED emission (newlines + 2-space indent for
 * long blocks/ternaries; JSONata is whitespace-insensitive) — it is what ships
 * by default, what `validateJsonata` parsed, and what the differential harness
 * evaluates. `.compact` is the canonical single-line emission the transpiler
 * produced — bake it explicitly by reading the `.compact` accessor where a
 * single-line string is wanted. For a `raw.jsonata` expression the two are
 * identical — hand-written strings are never reformatted.
 */
export class JsonataExpr<Ctx = unknown, R = unknown> implements RawRef {
  readonly __tdkRawRef = true as const;
  readonly __tdkJsonataExpr = true as const;

  constructor(
    /** The compiled, validated JSONata expression string (pretty-formatted). */
    readonly jsonata: string,
    /** The original author function — the JS test oracle. */
    readonly fn: (ctx: Ctx) => R,
    /** The canonical single-line emission (defaults to `jsonata` for raw expressions). */
    readonly compact: string = jsonata,
  ) {}

  /** Render to the Scaffolder expression string (always the pretty emission).
   * Env-independent. */
  render(_resolve: RefResolver): string {
    return `\${{ ${this.jsonata} }}`;
  }

  toString(): string {
    return this.render({ env: "" });
  }
}

export function isJsonataExpr(value: unknown): value is JsonataExpr {
  return (
    typeof value === "object" && value !== null && (value as { __tdkJsonataExpr?: unknown }).__tdkJsonataExpr === true
  );
}

/**
 * Validate a compiled JSONata string by parsing it. Throws if the engine
 * rejects it — a signal that the transpiler produced something malformed.
 */
export function validateJsonata(str: string): void {
  try {
    jsonataLib(str);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TranspileError(`Transpiler produced JSONata that does not parse: ${message}\n` + `  produced: ${str}`);
  }
}

/**
 * `jsonata<Ctx>((c) => <body>)` — transpile an arrow to a validated JSONata
 * expression.
 *
 * The arrow's single parameter maps to the JSONata root context: inside,
 * `c.parameters.x` becomes `parameters.x`. Only the context param, the arrow's
 * own lambda params (in `.map`/`.filter`), and literals may be referenced — no
 * closures or external variables.
 *
 * ```ts
 * type Ctx = { parameters: { cakeName: string } };
 * const e = jsonata<Ctx>((c) => ({ name: c.parameters.cakeName }));
 * e.jsonata; // => '{"name": parameters.cakeName}'
 * ```
 *
 * The returned expression carries BOTH renderings: `.jsonata` is the
 * pretty-formatted emission (what ships by default), `.compact` the canonical
 * single-line one — both validated by parsing.
 */
function jsonataImpl<Ctx, R = unknown>(fn: (ctx: Ctx) => R): JsonataExpr<Ctx, R> {
  const src = fn.toString();
  const compact = transpileArrowSource(src);
  const pretty = formatJsonata(compact);
  validateJsonata(compact);
  if (pretty !== compact) validateJsonata(pretty);
  return new JsonataExpr<Ctx, R>(pretty, fn, compact);
}

/**
 * The `raw.jsonata` / `jsonata.raw` escape hatch — inline a verbatim JSONata
 * string for anything the transpiler doesn't support. The string is still
 * validated by parsing. Interpolations may be primitives (spliced verbatim) or
 * other `jsonata(...)` expressions (their compiled JSONata is embedded);
 * anything else is rejected — `String(someObject)` would splice
 * `[object Object]` into the expression and blame the transpiler.
 *
 * ```ts
 * jsonata.raw`$sum(parameters.amounts)`
 * ```
 */
function rawJsonata(strings: TemplateStringsArray, ...values: unknown[]): JsonataExpr {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += rawInterpolation(values[i], i);
  }
  validateJsonata(out);
  // No JS oracle for raw JSONata — differential() will refuse to run it.
  const noOracle = (() => {
    throw new Error("raw.jsonata has no JS oracle; it cannot be used with differential().");
  }) as () => unknown;
  return new JsonataExpr(out, noOracle);
}

/** Render one raw-template interpolation, rejecting non-primitives. */
function rawInterpolation(value: unknown, index: number): string {
  if (isJsonataExpr(value)) return value.jsonata;
  const type = value === null ? "null" : typeof value;
  if (value === null || value === undefined || type === "object" || type === "function") {
    throw new TranspileError(
      `raw.jsonata interpolation #${index + 1} is a ${type} — it would splice ` +
        `"${String(value)}" into the expression. Interpolate a string/number/boolean ` +
        "or a jsonata(...) expression instead.",
    );
  }
  return String(value);
}

/** The public `jsonata` callable, with `.raw` attached. */
export const jsonata = Object.assign(jsonataImpl, { raw: rawJsonata }) as typeof jsonataImpl & {
  raw: typeof rawJsonata;
};

/** Also exported as `raw.jsonata` — wired in src/expr/index.ts. */
export { rawJsonata };

/**
 * The author-facing mirror of JSONata's `$assert`, for use inside block-bodied
 * `jsonata(...)` arrows: `assert(cond, msg)` transpiles to `$assert(cond, msg)`.
 *
 * This is the function the JS ORACLE runs, so a guard is exercised on BOTH
 * sides by the differential harness. When `cond` is falsy it throws
 * `Error(msg)` — the SAME message JSONata's `$assert` raises — so a failing
 * guard agrees throw-for-throw; otherwise it returns nothing (like `$assert`).
 *
 * ```ts
 * jsonata<Ctx>((c) => {
 *   assert(c.manager !== "", "Your line manager could not be resolved.");
 *   return { ok: true };
 * });
 * ```
 */
export function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Author-facing mirrors of JSONata's `$substringAfter` / `$substringBefore`, for
 * use inside `jsonata(...)` arrows. They compile to `$substringAfter(...)` /
 * `$substringBefore(...)` and, as the JS oracle, reproduce the engine's
 * semantics: the substring after / before the FIRST occurrence of `chars`, or
 * the whole string when `chars` is not found.
 *
 * ```ts
 * jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/"));
 * // => $substringAfter(ref, "user:default/")
 * ```
 */
export function substringAfter(str: string, chars: string): string {
  const i = str.indexOf(chars);
  return i === -1 ? str : str.slice(i + chars.length);
}

export function substringBefore(str: string, chars: string): string {
  const i = str.indexOf(chars);
  return i === -1 ? str : str.slice(0, i);
}

// Re-export the quote helper for tests asserting emitted strings if needed.
export { quote };
