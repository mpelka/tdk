// The `nj` API — the TS→Nunjucks transpiler surface authors import.
//
// `nj<Ctx>((c) => <body>)` transpiles the arrow's body to a Nunjucks expression
// string at authoring/build time and returns a value usable anywhere a `raw`
// expression is (step input, output, `if`). Compile wraps it in `${{ … }}` so the
// Scaffolder evaluates the Nunjucks at runtime — the Nunjucks analog of `jsonata`.

import nunjucks from "nunjucks";
import type { RawRef, RefResolver } from "../index.ts";
import { NjTranspileError, transpileArrowSourceNj } from "./transpile.ts";

export { NjTranspileError };

/**
 * The default `Ctx` shape — gives autocomplete on the Scaffolder roots
 * (`parameters` / `steps` / `secrets` / `user`) when no explicit context type is
 * supplied. All members are permissive so member/step access type-checks.
 */
export interface NjContext {
  // biome-ignore-start lint/suspicious/noExplicitAny: permissive author context — nj() arrows index arbitrary depth (e.g. c.parameters.x.y); `unknown` would force casts everywhere and kill author DX
  parameters: Record<string, any>;
  steps: Record<string, any>;
  secrets: Record<string, any>;
  user: Record<string, any>;
  // biome-ignore-end lint/suspicious/noExplicitAny: permissive author context for nj() arrows
}

/**
 * A compiled Nunjucks expression. Like `JsonataExpr`, it is a `RawRef` that
 * renders to a Scaffolder expression string at compile — here `${{ <nunjucks> }}`.
 * It exposes the bare compiled Nunjucks (`.nunjucks`) and the original JS
 * function (`.fn`) so the differential harness can run both sides.
 */
export class NunjucksExpr<Ctx = NjContext, R = unknown> implements RawRef {
  readonly __tdkRawRef = true as const;
  readonly __tdkNunjucksExpr = true as const;

  constructor(
    /** The compiled Nunjucks expression string (without `${{ }}`). */
    readonly nunjucks: string,
    /** The original author function — the JS test oracle. */
    readonly fn: (ctx: Ctx) => R,
  ) {}

  /** Render to the Scaffolder expression string. Env-independent. */
  render(_resolve: RefResolver): string {
    return `\${{ ${this.nunjucks} }}`;
  }

  toString(): string {
    return this.render({ env: "" });
  }
}

export function isNunjucksExpr(value: unknown): value is NunjucksExpr {
  return (
    typeof value === "object" && value !== null && (value as { __tdkNunjucksExpr?: unknown }).__tdkNunjucksExpr === true
  );
}

/**
 * `nj<Ctx>((c) => <body>)` — transpile a typed arrow to a Nunjucks expression.
 *
 * The arrow's single parameter maps to the Nunjucks root context: inside,
 * `c.parameters.x` becomes `parameters.x`. Only the context param and literals
 * may be referenced — no closures or external variables.
 *
 * ```ts
 * nj((c) => c.user);                        // => ${{ user }}
 * nj((c) => c.parameters.scheduled_start || "");
 * //                                        => ${{ (parameters.scheduled_start or "") }}
 * ```
 */
function njImpl<Ctx = NjContext, R = unknown>(fn: (ctx: Ctx) => R): NunjucksExpr<Ctx, R> {
  const src = fn.toString();
  const compiled = transpileArrowSourceNj(src);
  validateNunjucks(compiled);
  return new NunjucksExpr<Ctx, R>(compiled, fn);
}

/** A build-time validation environment matching how Backstage runs Nunjucks. */
const validationEnv = new nunjucks.Environment(undefined, { autoescape: false });

/**
 * Validate a compiled Nunjucks expression with the REAL engine — the analog of
 * the JSONata backend's parse-validation. Eager compilation catches SYNTAX
 * errors; the empty-context render catches FILTER garbage (Nunjucks resolves
 * filters only at render time, so e.g. an unparenthesized `s | trim.length`
 * compiles fine but can never render — "filter not found: trim.length").
 * Other render-time errors are DATA-dependent (builtin `| trim` throws on a
 * missing value, for instance) and are NOT validation failures — the empty
 * context legitimately leaves every lookup undefined.
 */
export function validateNunjucks(str: string): void {
  let template: nunjucks.Template;
  try {
    template = new nunjucks.Template(`{{ ${str} }}`, validationEnv, undefined, /*eagerCompile*/ true);
  } catch (err) {
    throw validationError(str, err);
  }
  try {
    template.render({});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/filter not found/i.test(message)) throw validationError(str, err);
  }
}

function validationError(str: string, err: unknown): NjTranspileError {
  const message = err instanceof Error ? err.message : String(err);
  return new NjTranspileError(
    `Transpiler produced Nunjucks that does not compile/render: ${message}\n` + `  produced: ${str}`,
  );
}

/** The public `nj` callable (room to attach helpers later, e.g. `nj.raw`). */
export const nj = njImpl;

/**
 * The author-facing nullish default, for use inside `nj(...)` arrows:
 * `njDefault(x, v)` transpiles to the null-aware inline-if
 * `(x if x != null else v)` and, as the JS oracle, returns `v` when `x` is
 * `null`/`undefined` (nullish), else `x`. `x ?? v` compiles the same.
 *
 * (Nunjucks' own `default` filter is NOT used: it fires only on undefined, so
 * a present `null` would slip through — diverging from `??`.)
 *
 * ```ts
 * nj((c) => njDefault(c.parameters.region, "eu"));
 * // => ${{ (parameters.region if parameters.region != null else "eu") }}
 * ```
 */
export function njDefault<T>(value: T, fallback: T): T {
  return value ?? fallback;
}
