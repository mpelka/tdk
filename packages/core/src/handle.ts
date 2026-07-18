// Shared handle machinery — the ONE guarded Proxy behind every step-reference
// handle (ADR-0025 phase 3).
//
// A "handle" is a typed reference to a step's output: `derive(...)` returns one
// rooted at `steps['<id>'].output.result`, and `effect(...)` exposes one via
// `.output` rooted at `steps['<id>'].output`. Both navigate property sub-refs
// (`h.body.url` → `…output.body.url`) with the SAME guards. This module is that
// single implementation — derive.ts and effects.ts both build their handles
// through `makeHandleProxy`, so there is never a second, subtly-different Proxy
// (the injection guard, the reserved-key set, and the identifier rule live in
// exactly one place).
//
// The type-level sub-ref shape (`ReservedSubRefKey`) is shared too; the two
// concrete handle types (`DeriveHandle` / `OutputRef`) wrap it in their own
// marker so a wrong-typed handle is still rejected in a `TypedInputValue<V>`
// slot.

import type { RawRef, RefResolver } from "./expr/index.ts";

// ---------------------------------------------------------------------------
// The type-level guard set — keys that can never be sub-refs.
// ---------------------------------------------------------------------------

/**
 * The keys omitted from a handle's sub-refs, so reaching one is a COMPILE error
 * (matching the runtime, which returns `undefined` for the reserved set and the
 * handle's own member for `render`/`toString`):
 *   - `render` / `toString` — the handle's own members (returned as themselves),
 *   - `then` / `catch` / `finally` — a sub-ref here would make a handle look
 *     thenable and break `await`,
 *   - `toJSON` / `valueOf` / `constructor` / `prototype` — serialization and
 *     object internals a runtime probes,
 *   - every `__`-prefixed key — TDK marker flags (`__tdkRawRef`, …) must read
 *     `undefined`, never a truthy sub-ref.
 */
export type ReservedSubRefKey =
  | "render"
  | "toString"
  | "then"
  | "catch"
  | "finally"
  | "toJSON"
  | "valueOf"
  | "constructor"
  | "prototype"
  | `__${string}`;

// ---------------------------------------------------------------------------
// The runtime guard set + injection rule.
// ---------------------------------------------------------------------------

/**
 * String keys that must NOT become sub-refs even though they are absent from the
 * target: promise/serialization/object internals a runtime may probe. Returning
 * a sub-ref here would make a handle look thenable (breaking `await`) or corrupt
 * `JSON.stringify`. All `__`-prefixed keys are likewise blocked in the `get`
 * trap (unknown TDK marker flags — a handle must read as `undefined` for
 * `__tdkJsonataExpr` etc., never as a truthy sub-ref).
 */
const RESERVED_KEYS = new Set(["then", "catch", "finally", "toJSON", "valueOf", "constructor", "prototype"]);

/**
 * The shape a sub-ref path segment must have: a plain identifier. Every segment
 * is spliced verbatim into the emitted `${{ steps['…'].output.<seg> }}` path, so
 * an unconstrained key could BREAK OUT of the expression (a key holding
 * `'] }} … {{ '` would terminate the block and open another — injection). The
 * check runs at sub-ref CREATION (the `get` trap), so the bad key fails at the
 * access site, not at some later render.
 */
export const SUBREF_SEGMENT = /^[A-Za-z_$][\w$]*$/;

/** The symbol under which a handle Proxy stores its `{ path, meta }`. */
export const HANDLE_INFO = Symbol("tdk.handleInfo");

/** The `{ path, meta }` a handle carries (read via `readHandleInfo`). */
export interface HandleInfo {
  /** The property path appended after the base (sub-refs). `[]` = root. */
  path: readonly string[];
  /** Handle-kind-specific payload (a derive descriptor, an effect step id, …). */
  meta: unknown;
}

/** The per-kind configuration `makeHandleProxy` closes over. */
export interface HandleSpec {
  /**
   * Marker flags set to `true` on the target and returned verbatim (never a
   * sub-ref) — e.g. `["__tdkRawRef", "__tdkDeriveHandle"]`. `render`/`toString`
   * are always own members; these are the kind-specific ones.
   */
  readonly flags: readonly string[];
  /** Render the full Scaffolder `${{ … }}` string for a given sub-ref path. */
  render(path: readonly string[]): string;
  /** Kind-specific payload stored under `HANDLE_INFO.meta` (shared by all sub-refs). */
  readonly meta: unknown;
  /** Location label for the injection error, e.g. `derive "x"` / `effect "y" output`. */
  readonly label: string;
  /** Trailing hint appended to the injection error (kind-specific remediation). */
  readonly injectionHint: string;
}

/**
 * Build a guarded handle Proxy over a real `RawRef` target, at sub-ref `path`.
 * Known members (`render`/`toString`/the marker flags) resolve to the target; an
 * unknown identifier key yields a SUB-REF handle with the path extended — after
 * validating the key against `SUBREF_SEGMENT` (a non-identifier key THROWS: it
 * would be spliced into the emitted expression path). Reserved and `__`-prefixed
 * keys read `undefined`. The single implementation both derive and effect handles
 * are built through.
 */
export function makeHandleProxy(spec: HandleSpec, path: readonly string[] = []): RawRef {
  const target: Record<PropertyKey, unknown> = {
    render(_resolve: RefResolver): string {
      return spec.render(path);
    },
    toString(): string {
      return spec.render(path);
    },
    [HANDLE_INFO]: { path, meta: spec.meta } satisfies HandleInfo,
  };
  const ownKeys = new Set<string>(["render", "toString"]);
  for (const flag of spec.flags) {
    target[flag] = true;
    ownKeys.add(flag);
  }
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (ownKeys.has(prop)) return Reflect.get(t, prop, receiver);
      if (prop.startsWith("__") || RESERVED_KEYS.has(prop)) return undefined;
      if (!SUBREF_SEGMENT.test(prop)) {
        throw new Error(
          `${spec.label}: sub-ref key ${JSON.stringify(prop)} is not a plain identifier — ` +
            `a sub-ref segment is spliced into the emitted \${{ }} path, so only ` +
            `[A-Za-z_$][A-Za-z0-9_$]* keys are allowed. ${spec.injectionHint}`,
        );
      }
      return makeHandleProxy(spec, [...path, prop]);
    },
    // A handle is opaque data — refuse mutation so a stray write can't corrupt it.
    set() {
      return false;
    },
  }) as unknown as RawRef;
}

/** Read a handle Proxy's `{ path, meta }`, or null for a non-handle. */
export function readHandleInfo(value: unknown): HandleInfo | null {
  if (typeof value !== "object" || value === null) return null;
  return (value as { [HANDLE_INFO]?: HandleInfo })[HANDLE_INFO] ?? null;
}
