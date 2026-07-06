// Value resolvers.
//
// A resolver lets an author drop a DEFERRED MARKER wherever a step input / `if`
// / output value is allowed — e.g. `person("Ada Lovelace")` — and have a
// registered async function replace it, at compile time, with a concrete value
// (e.g. an Active-Directory id). Core ships ONLY the mechanism: a process-wide
// registry, the plain marker, and an async resolution pass. The actual resolver
// (an AD lookup, etc.) is registered by a consumer plugin via `defineResolver`.
// Core never imports a concrete resolver.
//
// The existing `RawRef` mechanism is SYNCHRONOUS (it renders during `compile`),
// so an async resolver cannot reuse it — hence this separate pre-pass: markers
// are collected and awaited up front, then `compile` swaps each for its resolved
// value via a sync lookup.

/**
 * A deferred marker placed in the authored tree by a resolver factory. It names
 * the resolver to run and the args to pass it; `resolveMarkers` later swaps it
 * for a concrete value. A plain data object so it survives a structural check.
 */
export interface Resolvable {
  readonly __tdkResolvable: true;
  /** The registered resolver name to invoke. */
  readonly resolver: string;
  /** The author-supplied args passed to the resolver fn. */
  readonly args: readonly unknown[];
}

export function isResolvable(value: unknown): value is Resolvable {
  return (
    typeof value === "object" && value !== null && (value as { __tdkResolvable?: unknown }).__tdkResolvable === true
  );
}

/**
 * Resolution context passed to every resolver fn. Mirrors `RefResolver` so a
 * resolver can be env-aware (e.g. resolve against a test vs prod directory).
 */
export interface ResolveContext {
  /** The Backstage env this artifact is being compiled for (e.g. "test"). */
  env: string;
}

/** A registered resolver: turns a marker's args into a concrete value. */
export type ResolverFn = (ctx: ResolveContext, ...args: unknown[]) => unknown | Promise<unknown>;

/**
 * The result of a resolution pass: each unique marker's resolved value keyed by
 * `resolvedKey(marker, env)`, so `compile` can look up the same key synchronously.
 */
export type ResolvedMap = Map<string, unknown>;

/**
 * Registry of every resolver registered in the process, by name. Mirrors the
 * env.pick registry style (a module-level singleton + a `_reset…` for tests).
 */
const registry = new Map<string, ResolverFn>();

/** Reset the resolver registry (used by tests for isolation). */
export function _resetResolvers(): void {
  registry.clear();
}

/**
 * Register a resolver and get back a typed marker FACTORY authors call:
 *
 * ```ts
 * const person = defineResolver("person", (ctx, name: string) => lookupId(name));
 * // ...later, anywhere a value is allowed:
 * input: { author: person("Ada Lovelace") }
 * ```
 *
 * Re-registering the SAME function reference is tolerated (module reload);
 * registering a DIFFERENT function under a taken name throws.
 */
export function defineResolver<A extends unknown[], R>(
  name: string,
  fn: (ctx: ResolveContext, ...args: A) => R | Promise<R>,
): (...args: A) => Resolvable {
  const existing = registry.get(name);
  if (existing && existing !== fn) {
    throw new Error(
      `defineResolver: a different resolver is already registered for "${name}". Resolver names must be unique.`,
    );
  }
  registry.set(name, fn as ResolverFn);
  return (...args: A): Resolvable => ({
    __tdkResolvable: true,
    resolver: name,
    args,
  });
}

/**
 * The cache key for a marker under a given env. Equal args + resolver + env
 * yield the same key, so identical markers resolve exactly once and `compile` can
 * recompute the key to look the value back up. A JSON-encoded [resolver, args, env] tuple keys it, so
 * they cannot collide across the boundary.
 */
export function resolvedKey(marker: Resolvable, env: string): string {
  return JSON.stringify([marker.resolver, marker.args, env]);
}

/**
 * Is `value` a plain object (an authored record), as opposed to a class
 * instance? Only plain objects / arrays are descended into; DSL value objects
 * (env.pick, raw/jsonata/nunjucks expressions, …) are opaque leaves — they
 * cannot contain markers and some carry cyclic ASTs. Keeping this structural
 * keeps `resolve.ts` free of any DSL import.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-walk a value, collecting every `Resolvable` (deduped by cache key). */
function collectMarkers(value: unknown, into: Map<string, Resolvable>, env: string): void {
  if (isResolvable(value)) {
    // A marker is a leaf: its args are static data, not a tree to descend.
    into.set(resolvedKey(value, env), value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectMarkers(v, into, env);
    return;
  }
  if (isPlainObject(value)) {
    for (const v of Object.values(value)) collectMarkers(v, into, env);
  }
}

/**
 * Async resolution pass. Deep-walks every root, collects each unique marker,
 * and invokes its registered resolver exactly once (awaited). Returns the
 * resolved values keyed by `resolvedKey` for `compile`/`lookupResolved` to read.
 *
 * Throws if a marker names a resolver that was never registered.
 */
export async function resolveMarkers(roots: unknown[], ctx: ResolveContext): Promise<ResolvedMap> {
  const markers = new Map<string, Resolvable>();
  for (const root of roots) collectMarkers(root, markers, ctx.env);

  const resolved: ResolvedMap = new Map();
  for (const [key, marker] of markers) {
    const fn = registry.get(marker.resolver);
    if (!fn) {
      throw new Error(
        `resolveMarkers: no resolver registered for "${marker.resolver}". ` +
          `Register it with defineResolver("${marker.resolver}", ...) before compile.`,
      );
    }
    resolved.set(key, await fn(ctx, ...marker.args));
  }
  return resolved;
}

/**
 * Sync lookup of a marker's already-resolved value. Used by `compile` to swap a
 * marker for its concrete value. If the value is missing, the template was
 * compiled via the SYNC `compile()` path, which cannot run async resolvers.
 */
export function lookupResolved(marker: Resolvable, env: string, resolved: ResolvedMap | undefined): unknown {
  const key = resolvedKey(marker, env);
  if (resolved?.has(key)) return resolved.get(key);
  throw new Error(
    `resolver "${marker.resolver}": this template uses a resolver marker but was ` +
      `compiled via the synchronous compile() path, which cannot run async ` +
      `resolvers. Use compileResolved(...) or compileAll(...) instead — both resolve ` +
      `markers asynchronously.`,
  );
}
