// Expression layer.
//
// M1 SCOPE: raw-string expressions only. The `raw` tagged template builds a
// single Backstage Scaffolder expression string out of literals and "refs"
// (param `.ref`s and `env.pick` markers). It does NOT transpile TypeScript to
// JSONata — that is milestone M2. Everything here resolves to a plain string.

/**
 * Anything that can be interpolated into a `raw` expression. A `RawRef` knows
 * how to render itself to a Scaffolder expression fragment. At authoring time a
 * param's `.ref` and an `env.pick(...)` both produce `RawRef`s; literals
 * (string/number/boolean) are stringified as-is.
 */
export interface RawRef {
  /** Marker so compile/raw can detect refs structurally. */
  readonly __tdkRawRef: true;
  /**
   * Render to a Scaffolder expression fragment.
   *
   * `resolve` lets env-dependent refs (env.pick) emit the value for the target
   * env being compiled. Param refs ignore it and always emit
   * `${{ parameters.<name> }}`.
   */
  render(resolve: RefResolver): string;
}

/** Resolution context passed through rendering at compile time. */
export interface RefResolver {
  /** The Backstage env this artifact is being compiled for (e.g. "test"). */
  env: string;
}

export function isRawRef(value: unknown): value is RawRef {
  return typeof value === "object" && value !== null && (value as { __tdkRawRef?: unknown }).__tdkRawRef === true;
}

/**
 * A finished raw expression. Carries its template parts + interpolated values
 * so compile can render it once it knows the target env. Until then it is opaque.
 */
export class RawExpr {
  readonly __tdkRawExpr = true as const;
  constructor(
    private readonly strings: readonly string[],
    private readonly values: readonly unknown[],
  ) {}

  /** Render to the final Scaffolder expression string for a given env. */
  render(resolve: RefResolver): string {
    let out = "";
    for (let i = 0; i < this.strings.length; i++) {
      out += this.strings[i];
      if (i < this.values.length) {
        out += renderValue(this.values[i], resolve);
      }
    }
    return out;
  }
}

export function isRawExpr(value: unknown): value is RawExpr {
  return value instanceof RawExpr;
}

function renderValue(value: unknown, resolve: RefResolver): string {
  if (isRawRef(value)) return value.render(resolve);
  if (isRawExpr(value)) return value.render(resolve);
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * `raw` tagged template — interpolates param `.ref`s, `env.pick` markers, and
 * literals into one verbatim Scaffolder expression string:
 *
 * ```ts
 * raw`Creating ${this.params.cakeName.ref} in ${env.pick({ test: "t", prod: "p" })}`
 * ```
 *
 * `raw.jsonata\`...\`` is the M2 escape hatch: inline a verbatim JSONata
 * expression (validated by parsing) for anything the TS→JSONata transpiler in
 * `jsonata(...)` doesn't support. See `src/expr/jsonata`.
 */
function rawImpl(strings: TemplateStringsArray, ...values: unknown[]): RawExpr {
  return new RawExpr(Array.from(strings), values);
}

import { rawJsonata } from "./jsonata/index.ts";

export const raw = Object.assign(rawImpl, { jsonata: rawJsonata }) as typeof rawImpl & {
  jsonata: typeof rawJsonata;
};
