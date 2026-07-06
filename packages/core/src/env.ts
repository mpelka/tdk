// Environments.
//
// `env.pick({ dev, staging, prod, default? })` is a marker placed wherever a
// value differs per deploy env. At compile time it resolves to the value for the
// target's env (falling back to a reserved `default` key when present). A
// process-wide registry keeps every pick so the env-safety check knows which
// values are EXCLUSIVE to an env (i.e. must never appear in an artifact compiled
// for a different env).

import type { RawRef, RefResolver } from "./expr/index.ts";

/**
 * The per-env values a pick offers. Arbitrary env-name keys (each mapping to a
 * value for that env), plus an optional reserved **`default`** key used as the
 * fallback when the target env has no explicit entry. At least one key is
 * required — enforced at runtime in `env.pick`.
 */
export type EnvValues<T> = Record<string, T>;

/** The reserved fallback key in an `EnvValues` map. */
const DEFAULT_KEY = "default";

/**
 * An `env.pick(...)` marker. It is a `RawRef` (so it can be interpolated into
 * `raw` expressions) AND can stand alone as a step-input value, where compile
 * swaps it for the env-specific value directly.
 */
export class EnvPick<T> implements RawRef {
  readonly __tdkRawRef = true as const;
  readonly __tdkEnvPick = true as const;

  constructor(readonly values: EnvValues<T>) {}

  /**
   * The concrete value for a given env (silent→loud): the explicit `values[env]`
   * if present, else the `default` fallback if present, else THROW — naming the
   * pick's known envs and the requested one so the fix is obvious.
   */
  resolve(env: string): T {
    if (Object.hasOwn(this.values, env)) return this.values[env] as T;
    if (Object.hasOwn(this.values, DEFAULT_KEY)) return this.values[DEFAULT_KEY] as T;
    const known = Object.keys(this.values)
      .filter((k) => k !== DEFAULT_KEY)
      .join(", ");
    throw new Error(
      `env.pick has no value for env "${env}" (knows: ${known}) — ` + `add a "${env}" entry or a "${DEFAULT_KEY}".`,
    );
  }

  /**
   * RawRef rendering: emit the env-specific value as a string fragment. Only
   * scalars can be interpolated — an object/array used to stringify to
   * `[object Object]` garbage, so it throws instead. (A non-scalar pick is
   * still fine as a STANDALONE step-input value, where compile keeps its
   * native shape.)
   */
  render(resolve: RefResolver): string {
    const value = this.resolve(resolve.env);
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      const kind =
        value === null ? "null" : Array.isArray(value) ? "an array" : t === "object" ? "an object" : `a ${t}`;
      throw new Error(
        `env.pick: cannot interpolate ${kind} into a string expression — it would render as garbage. ` +
          `Use the pick as a standalone input value (compile keeps its native shape), or pick a scalar.`,
      );
    }
    return String(value);
  }
}

export function isEnvPick(value: unknown): value is EnvPick<unknown> {
  return typeof value === "object" && value !== null && (value as { __tdkEnvPick?: unknown }).__tdkEnvPick === true;
}

/**
 * Registry of the `env.pick`s created in the process. Used by the env-safety
 * check to enumerate, per env, the string values EXCLUSIVE to that env — values
 * that appear in that env's slot but in no other env's slot, and so must never
 * surface in an artifact compiled for a different env.
 *
 * Deduped by value map: `build()` runs per compile and re-creates its picks,
 * so an unbounded array would grow forever in a long-lived process (watch
 * mode, the VS Code extension). Only string-bearing picks are registered at
 * all — the safety scan compares strings, so others can never contribute.
 */
const registry = new Map<string, EnvPick<unknown>>();
let unkeyedCounter = 0;

/** A stable registry key for a pick's value map, or null when the pick can
 * never affect the exclusive-value scan (no string in any slot). */
function registryKey(values: EnvValues<unknown>): string | null {
  if (!Object.values(values).some((v) => typeof v === "string")) return null;
  try {
    // Sort keys so `{ test, prod }` and `{ prod, test }` dedupe to one entry.
    const sorted = Object.keys(values)
      .sort()
      .map((k) => [k, values[k]] as const);
    return JSON.stringify(sorted);
  } catch {
    // An unserializable (e.g. circular) companion value — keep it, uniquely keyed.
    return `__tdkUnkeyed:${unkeyedCounter++}`;
  }
}

/**
 * Compute, per env name, the set of string values EXCLUSIVE to that env across
 * all registered picks.
 *
 * A value is exclusive to env E when it is used as some pick's value for E and
 * is not used as any pick's value for a DIFFERENT env (a value legitimately
 * shared across envs is not a leak). The reserved `default` key is a fallback,
 * not an env, so it never contributes an exclusive value and its values count
 * as "shared" (present via default for every env). Only string values
 * participate — the safety scan compares strings inside the compiled artifact.
 */
export function exclusiveValuesByEnv(): Map<string, Set<string>> {
  // env name → the string values that appear in that env's slot.
  const byEnv = new Map<string, Set<string>>();
  // string values that appear under the `default` key (shared across all envs).
  const defaults = new Set<string>();
  for (const pick of registry.values()) {
    for (const [envName, value] of Object.entries(pick.values)) {
      if (typeof value !== "string") continue;
      if (envName === DEFAULT_KEY) {
        defaults.add(value);
        continue;
      }
      let set = byEnv.get(envName);
      if (!set) {
        set = new Set<string>();
        byEnv.set(envName, set);
      }
      set.add(value);
    }
  }
  const result = new Map<string, Set<string>>();
  for (const [envName, values] of byEnv) {
    const exclusive = new Set<string>();
    for (const v of values) {
      if (defaults.has(v)) continue; // a default value is present for every env
      let sharedWithOther = false;
      for (const [otherEnv, otherValues] of byEnv) {
        if (otherEnv === envName) continue;
        if (otherValues.has(v)) {
          sharedWithOther = true;
          break;
        }
      }
      if (!sharedWithOther) exclusive.add(v);
    }
    result.set(envName, exclusive);
  }
  return result;
}

/** Reset the registry (used by tests for isolation). */
export function _resetEnvRegistry(): void {
  registry.clear();
}

/** The number of registered (deduped) picks — exposed for tests only. */
export function _envRegistrySize(): number {
  return registry.size;
}

export const env = {
  /**
   * Mark a value that differs per deploy env. Resolved by compile to the target
   * env's value (or the `default` fallback); every branch is recorded so
   * env-safety can detect leaks.
   *
   * ```ts
   * cluster: env.pick({ dev: "dev-cluster", staging: "stg-cluster", prod: "prod-cluster" })
   * region:  env.pick({ prod: "eu-west", default: "eu-central" })
   * ```
   */
  pick<T>(values: EnvValues<T>): EnvPick<T> {
    if (Object.keys(values).length === 0) {
      throw new Error(`env.pick requires at least one env value (an env name or "${DEFAULT_KEY}").`);
    }
    const pick = new EnvPick(values);
    const key = registryKey(values);
    if (key !== null && !registry.has(key)) registry.set(key, pick);
    return pick;
  },
};
