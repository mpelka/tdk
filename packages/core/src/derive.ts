// Derived values — `derive(name, inputs, fn)` (ADR-0025 Decision 2, phase 3a).
//
// A `derive` declares a runtime-computed value as a dataflow node. Its `inputs`
// are typed references (field refs, other derive handles, or `nj()`/`jsonata()`
// markers); its `fn` is transpiled by the SAME TS→JSONata transpiler `jsonata()`
// uses (never forked); and it returns a typed HANDLE that renders, wherever it is
// consumed, to `${{ steps['<name>'].output.result }}` — the author never writes
// that string. The compiler materializes each reachable derive as a
// `roadiehq:utils:jsonata` step whose `data:` map is generated from `inputs` and
// whose `expression:` is the transpiled lambda, then TOPOLOGICALLY orders the
// combined graph of manual steps and derives (`planDerives`).
//
// This is the phase-3a slice: `derive` inside the CURRENT template shape (a manual
// `steps` list still exists). The full v2 surface — pages-as-TOC, an `effects`
// list, handle-based `output` — is the next slice. Everything here is ADDITIVE:
// a template that uses no `derive` compiles exactly as before (`planDerives`
// short-circuits to the manual steps unchanged).

import { isEnvPick } from "./env.ts";
import type { RawRef, RefResolver } from "./expr/index.ts";
import { isRawExpr, isRawRef } from "./expr/index.ts";
import type { JsonataExpr } from "./expr/jsonata/index.ts";
import { jsonata } from "./expr/jsonata/index.ts";
import type { ConditionalBrand } from "./params.ts";
import { ParamBase, ParamRef } from "./params.ts";
import { isResolvable } from "./resolve.ts";
import type { InputValue, Step } from "./template.ts";
import type { MarkerValue } from "./typed-input.ts";

// ---------------------------------------------------------------------------
// The handle type — a result-typed marker with property sub-refs.
// ---------------------------------------------------------------------------

/**
 * The marker at the core of a derive handle: a `RawRef` (so it renders to a
 * Scaffolder expression wherever an `InputValue` is accepted) carrying the
 * lambda's return type `R`. It is a first-class `TypedMarker` kind (see
 * typed-input.ts) — a handle rendering the wrong type is rejected in a
 * `TypedInputValue<V>` slot, and `MarkerValue<DeriveMarker<R>>` recovers `R`.
 *
 * The two phantoms mirror the lesson `Ref` learned (typed-input.ts): both are
 * REQUIRED, never optional, so a bare object carrying neither can never pose as
 * a `DeriveMarker<V>` for every `V`. Neither exists at runtime — every handle is
 * a cast Proxy (see `makeHandle`).
 */
export interface DeriveMarker<R> extends RawRef {
  /** Marker so the planner and `MarkerValue` detect a handle structurally. */
  readonly __tdkDeriveHandle: true;
  /** Phantom — carries the lambda's return type `R`. Never present at runtime. */
  readonly __tdkResultType: R;
}

/**
 * The keys that can never be sub-refs, excluded from `DeriveSubRefs` so reaching
 * one is a COMPILE error (matching the runtime, which returns `undefined` for
 * the reserved set and the marker's own member for `render`/`toString`):
 *   - `render` / `toString` — the marker's own members (returned as themselves),
 *   - `then` / `catch` / `finally` — a sub-ref here would make a handle look
 *     thenable and break `await`,
 *   - `toJSON` / `valueOf` / `constructor` / `prototype` — serialization and
 *     object internals a runtime probes,
 *   - every `__`-prefixed key — TDK marker flags (`__tdkJsonataExpr`, …) must
 *     read `undefined`, never a truthy sub-ref.
 */
type ReservedSubRefKey =
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

/**
 * The typed sub-refs an OBJECT-typed handle exposes: one handle per property, so
 * `jira.summary` is a handle to `steps['jira'].output.result.summary` carrying
 * that property's type. Optional properties are unwrapped (`NonNullable`) — a
 * sub-ref names a concrete path, and absence is the reader's concern at that
 * leaf, not the ref's.
 *
 * LIMITS (documented, deliberate):
 *   - Arrays expose NO per-element sub-refs — the whole array handle is used (an
 *     index signature has no finite key set to map). `R` an array → no sub-refs.
 *   - Scalars have no sub-refs.
 *   - A property named by `ReservedSubRefKey` is NOT reachable as a sub-ref: the
 *     type omits it (a compile error), and the runtime returns `undefined`
 *     (reserved keys) or the marker's own member (`render`/`toString`). Such
 *     keys are vanishingly rare in Backstage step outputs.
 *   - A sub-ref segment must be a plain identifier (`/^[A-Za-z_$][\w$]*$/`) —
 *     any other key THROWS at access time (see `makeHandle`), because the
 *     segment is spliced into the emitted `${{ … }}` path.
 *   - Enumeration is asymmetric: `'a' in handle` is `false` and `Object.keys`
 *     exposes only the marker members — sub-refs exist on ACCESS, not as own
 *     properties (the Proxy fabricates them in the `get` trap).
 */
type DeriveSubRefs<R> = R extends readonly unknown[]
  ? unknown
  : R extends object
    ? { readonly [K in Exclude<keyof R, ReservedSubRefKey>]-?: DeriveHandle<NonNullable<R[K]>> }
    : unknown;

/**
 * A typed derive handle: the result-carrying marker plus its property sub-refs.
 * Returned by `derive(...)` and by every sub-ref access on an object-typed
 * handle. Satisfies `TypedInputValue<R>` and `InputValue`, so it drops into any
 * step input, another derive's inputs, or `output`.
 */
export type DeriveHandle<R> = DeriveMarker<R> & DeriveSubRefs<R>;

// ---------------------------------------------------------------------------
// The internal descriptor + registry.
// ---------------------------------------------------------------------------

/**
 * The internal record behind one `derive(...)` call, shared by its root handle
 * and every sub-ref of it. Carries the planning data: the step `id`/`name`, the
 * `inputs` (rendered into the `data:` map and walked for dependencies), and the
 * transpiled expression.
 */
export interface DeriveDescriptor {
  /** The step id (also the derive's unique name within a template). */
  readonly name: string;
  /** The user-visible step `name` (Backstage run log). Title-cased id by default. */
  readonly stepName: string;
  /** The typed references, keyed by the lambda's context field names. */
  readonly inputs: Record<string, unknown>;
  /** The transpiled lambda — the same `JsonataExpr` `jsonata()` produces. */
  readonly expr: JsonataExpr;
}

/** The symbol under which a handle Proxy stores its `{ descriptor, path }`. */
const HANDLE_INFO = Symbol("tdk.deriveHandle");

/** The `{ descriptor, path }` a handle carries, read via `handleInfo`. */
interface HandleInfo {
  descriptor: DeriveDescriptor;
  /** The property path appended after `.output.result` (sub-refs). `[]` = root. */
  path: readonly string[];
}

/**
 * Every `derive(...)` ever created, for the unreachable-derive warning. A module
 * registry, mirroring the env / action-simulator registries: process-wide, with
 * a `_resetDeriveRegistry` reset for tests. It backs a BEST-EFFORT diagnostic
 * only — the compiler never depends on it for correctness (an unreachable derive
 * is simply not emitted). The warning is ATTRIBUTED per template: a compile only
 * reports an unreachable derive whose param inputs all belong to ITS OWN form
 * (see `attributableToForm`), so one template's orphan never surfaces in another
 * template's diagnostics.
 */
const declaredDerives = new Set<DeriveDescriptor>();

/** Clear the declared-derive registry (tests — see `declaredDerives`). */
export function _resetDeriveRegistry(): void {
  declaredDerives.clear();
}

// ---------------------------------------------------------------------------
// Handle construction — a guarded Proxy.
// ---------------------------------------------------------------------------

/** Marker members that live on the target — returned as-is, never a sub-ref. */
const OWN_MEMBERS = new Set(["__tdkRawRef", "__tdkDeriveHandle", "render", "toString"]);

/**
 * String keys that must NOT become sub-refs even though they are absent from the
 * target: promise/serialization/object internals a runtime may probe. Returning
 * a sub-ref here would make a handle look thenable (breaking `await`) or corrupt
 * `JSON.stringify`. All `__`-prefixed keys are likewise blocked (unknown TDK
 * marker flags — a handle must read as `undefined` for `__tdkJsonataExpr` etc.,
 * never as a truthy sub-ref).
 */
const RESERVED_KEYS = new Set(["then", "catch", "finally", "toJSON", "valueOf", "constructor", "prototype"]);

/** Render a handle to its Scaffolder expression string (env-independent). */
function renderHandle(descriptor: DeriveDescriptor, path: readonly string[]): string {
  const suffix = path.map((seg) => `.${seg}`).join("");
  return `\${{ steps['${descriptor.name}'].output.result${suffix} }}`;
}

/**
 * The shape a sub-ref path segment must have: a plain identifier. Every segment
 * is spliced verbatim into the emitted `${{ steps['…'].output.result.<seg> }}`
 * path, so an unconstrained key could BREAK OUT of the expression (a key holding
 * `'] }} … {{ '` would terminate the block and open another — injection). The
 * check runs at sub-ref CREATION (the `get` trap), so the bad key fails at the
 * access site, not at some later render.
 */
const SUBREF_SEGMENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Build a handle Proxy over a real `RawRef` target. Known members resolve to the
 * target; an unknown data-like string key yields a SUB-REF handle with the path
 * extended (`jira.summary` → a handle to `.result.summary`) — after validating
 * the key against `SUBREF_SEGMENT` (a non-identifier key THROWS: it would be
 * spliced into the emitted expression path). See `DeriveSubRefs` for the limits
 * this trap enforces.
 */
function makeHandle<R>(descriptor: DeriveDescriptor, path: readonly string[]): DeriveHandle<R> {
  const target = {
    __tdkRawRef: true as const,
    __tdkDeriveHandle: true as const,
    [HANDLE_INFO]: { descriptor, path } satisfies HandleInfo,
    render(_resolve: RefResolver): string {
      return renderHandle(descriptor, path);
    },
    toString(): string {
      return renderHandle(descriptor, path);
    },
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (OWN_MEMBERS.has(prop)) return Reflect.get(t, prop, receiver);
      if (prop.startsWith("__") || RESERVED_KEYS.has(prop)) return undefined;
      if (!SUBREF_SEGMENT.test(prop)) {
        throw new Error(
          `derive "${descriptor.name}": sub-ref key ${JSON.stringify(prop)} is not a plain identifier — ` +
            `a sub-ref segment is spliced into the emitted \${{ }} path, so only ` +
            `[A-Za-z_$][A-Za-z0-9_$]* keys are allowed. Reshape the derive's return to use an ` +
            `identifier key, or read the value with an explicit nj() expression instead.`,
        );
      }
      return makeHandle(descriptor, [...path, prop]);
    },
    // A handle is opaque data — refuse mutation so a stray write can't corrupt it.
    set() {
      return false;
    },
  }) as unknown as DeriveHandle<R>;
}

/** True for a derive handle (root or sub-ref). */
export function isDeriveHandle(value: unknown): value is DeriveMarker<unknown> {
  return (
    typeof value === "object" && value !== null && (value as { __tdkDeriveHandle?: unknown }).__tdkDeriveHandle === true
  );
}

/** Read a handle's internal `{ descriptor, path }`; null for a non-handle. */
function handleInfo(value: unknown): HandleInfo | null {
  if (!isDeriveHandle(value)) return null;
  return (value as unknown as { [HANDLE_INFO]?: HandleInfo })[HANDLE_INFO] ?? null;
}

/**
 * The transpiled `JsonataExpr` behind a derive handle — the same expression the
 * derived step emits. Exposed for differential testing (feed it to
 * `assertDifferentialJsonata`) and tooling; throws on a non-handle.
 */
export function getDeriveExpr(handle: DeriveMarker<unknown>): JsonataExpr {
  const info = handleInfo(handle);
  if (!info) throw new Error("getDeriveExpr: value is not a derive handle.");
  return info.descriptor.expr;
}

// ---------------------------------------------------------------------------
// The `derive` authoring surface.
// ---------------------------------------------------------------------------

/**
 * An object of typed references — a field ref (`f.x`), a param CONST directly
 * (`severity`, the ADR-0025 Decision 2 surface), another derive handle (or its
 * property sub-ref), an `nj()`/`jsonata()` marker, or a literal.
 */
export type DeriveInputs = Record<string, unknown>;

/**
 * The value type one derive input contributes to the lambda's context —
 * conditionality-aware:
 *   - a param CONST (`Param<T>`) → `T`, or `T | undefined` when it carries a
 *     `showWhen` (branded `ConditionalBrand` — by the `.showWhen(...)` method's
 *     return type, or by the `showWhen:`-carrying overload of each `p.*`
 *     factory),
 *   - anything else (a `Ref<T>` field ref, a derive handle, `nj`/`jsonata`, a
 *     literal) → the value its marker carries (`MarkerValue`). A conditional
 *     field's ref is already `Ref<T | undefined>`, so both spellings agree.
 */
export type DeriveInputValue<M> =
  M extends ParamBase<infer T> ? (M extends ConditionalBrand ? T | undefined : T) : MarkerValue<M>;

/**
 * The lambda's INFERRED context: each input mapped to its value type — no
 * hand-written `Ctx`, no `data:` map. A field with a `showWhen` types as
 * `T | undefined`, forcing the lambda to handle absence (ADR-0025 Decision 2).
 */
export type DeriveContext<I extends DeriveInputs> = { [K in keyof I]: DeriveInputValue<I[K]> };

/** Options for `derive(...)`. */
export interface DeriveOptions {
  /**
   * The user-visible step `name` (Backstage run log). Defaults to the id
   * title-cased — word-split on `-`/`_`/whitespace, each word capitalized
   * (`"sla-hours"` → `"Sla Hours"`). Override for a phrase the log should read
   * verbatim (`"Build the order ticket"`).
   */
  name?: string;
}

/**
 * Derive the id's default user-visible name: split on `-`/`_`/whitespace and
 * title-case each word. `"ticket-title"` → `"Ticket Title"`.
 */
function titleCaseId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Declare a named runtime-computed value.
 *
 * ```ts
 * const slaHours = derive("sla-hours", { severity }, (i) =>
 *   i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
 * );
 * ```
 *
 * `inputs` are typed references; the lambda's context is inferred from them
 * (`{ [K]: MarkerValue<inputs[K]> }`) — no hand-written `Ctx`, no `data:` map. The
 * lambda transpiles exactly as a `jsonata(...)` arrow does (the roadie
 * `expression:` reads the `data:` fields BARE, so `i.severity` compiles to
 * `severity`). Consuming the returned handle anywhere auto-wires
 * `${{ steps['sla-hours'].output.result }}`; property access on an object-typed
 * handle yields a typed sub-ref. The name is mandatory and explicit — step names
 * are user-visible in the Backstage run log.
 */
export function derive<const I extends DeriveInputs, R>(
  name: string,
  rawInputs: I,
  fn: (i: DeriveContext<I>) => R,
  opts: DeriveOptions = {},
): DeriveHandle<R> {
  // The lambda transpiles through the SAME `jsonata()` builder — same transpiler,
  // same parse-validation, same differential-testing obligations. Never forked.
  const expr = jsonata(fn as (ctx: unknown) => R);
  // Normalize a param CONST input to its `.ref` (renders `${{ parameters.<name> }}`,
  // like a field ref) so the descriptor's inputs are uniform markers — the walks
  // and the generated `data:` map never see a raw Param. (`.ref` binds its name
  // lazily at compile, so creating it here, before the name is bound, is safe.)
  const inputs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    inputs[key] = value instanceof ParamBase ? value.ref : value;
  }
  const descriptor: DeriveDescriptor = {
    name,
    stepName: opts.name ?? titleCaseId(name),
    inputs,
    expr,
  };
  declaredDerives.add(descriptor);
  return makeHandle<R>(descriptor, []);
}

// ---------------------------------------------------------------------------
// The planner — reachability collection + topological ordering.
// ---------------------------------------------------------------------------

/** The result of planning: the ordered steps and any non-fatal diagnostics. */
export interface PlanResult {
  /** Manual steps + reachable derived steps, in topological order. */
  steps: Step[];
  /** Non-fatal compile warnings (e.g. an unreachable derive). */
  diagnostics: string[];
}

/** Extract every `steps['id']` / `steps.id` step id referenced in a string. */
function extractStepIds(source: string): string[] {
  const re = /steps(?:\[\s*["']([^"']+)["']\s*\]|\.([A-Za-z_$][\w$]*))/g;
  const ids: string[] = [];
  for (const m of source.matchAll(re)) ids.push(m[1] ?? m[2]!);
  return ids;
}

/**
 * A marker whose rendered string may carry a `steps[...]` reference: `nj`,
 * `jsonata`, a param ref, or a `raw` expression — all render env-INDEPENDENTLY.
 * An `env.pick`/resolver marker is NOT one: a resolver defers to compile time
 * and never names a step; an env.pick's BRANCHES may hold step-referencing
 * markers, but the pick itself must never be rendered against a placeholder env
 * (it would resolve, and can throw) — the walks descend into `pick.values`
 * instead (see `forEachHandle` / `depsOf`).
 */
function isRenderableRef(value: unknown): value is RawRef {
  return (isRawRef(value) || isRawExpr(value)) && !isEnvPick(value) && !isResolvable(value);
}

/**
 * Walk a value tree, invoking `onHandle` for each derive handle (NOT descending
 * into its sub-refs — they share one descriptor). Used to find reachable derives.
 * Leaf markers (`nj`/`jsonata`/refs/resolvers) contain no nested handle objects,
 * so they are not descended into — EXCEPT `env.pick`, whose branches are
 * arbitrary values: every branch is walked (the union over all envs), so a
 * handle inside any env's branch is reachable in every env's artifact.
 * Conservative on purpose — an extra emitted step in an env that does not pick
 * that branch is harmless; a missing step in one that does is a broken artifact.
 */
function forEachHandle(value: unknown, onHandle: (info: HandleInfo) => void): void {
  const info = handleInfo(value);
  if (info) {
    onHandle(info);
    return;
  }
  if (value instanceof ParamBase) return; // a bare param — renders to its own ref
  if (isEnvPick(value)) {
    for (const branch of Object.values(value.values)) forEachHandle(branch, onHandle);
    return;
  }
  if (isRawRef(value) || isRawExpr(value) || isResolvable(value)) return;
  if (Array.isArray(value)) {
    for (const v of value) forEachHandle(v, onHandle);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) forEachHandle(v, onHandle);
  }
}

/**
 * Collect every derive reachable from the roots (manual step inputs/if, output),
 * transitively through derives' own inputs. Throws on a duplicate name (two
 * distinct derives sharing one name — their steps would collide).
 */
function collectReachable(roots: unknown[]): Map<string, DeriveDescriptor> {
  const reachable = new Map<string, DeriveDescriptor>();
  const visit = (info: HandleInfo): void => {
    const d = info.descriptor;
    const existing = reachable.get(d.name);
    if (existing) {
      if (existing !== d) {
        throw new Error(
          `derive: duplicate derived-value name "${d.name}" — two different derive(...) declarations ` +
            `share one name, but names are unique per template (their steps would collide). Rename one.`,
        );
      }
      return;
    }
    reachable.set(d.name, d);
    // A reachable derive's own inputs may reference more derives — recurse.
    for (const input of Object.values(d.inputs)) forEachHandle(input, visit);
  };
  for (const root of roots) forEachHandle(root, visit);
  return reachable;
}

/** The ordering dependencies of one node: the ids that must precede it. */
interface NodeDeps {
  /** Reachable derive names this node references. */
  derives: Set<string>;
  /** Manual step ids this node references. */
  steps: Set<string>;
}

/** Compute the step ids (derive + manual) a value tree references. */
function depsOf(inputs: unknown[], reachable: Map<string, DeriveDescriptor>, manualIds: Set<string>): NodeDeps {
  const derives = new Set<string>();
  const steps = new Set<string>();
  const classify = (id: string): void => {
    if (reachable.has(id)) derives.add(id);
    else if (manualIds.has(id)) steps.add(id);
    // An id that is neither is a dangling reference — Backstage's problem, not
    // the planner's; it adds no ordering constraint.
  };
  const scan = (value: unknown): void => {
    const info = handleInfo(value);
    if (info) {
      derives.add(info.descriptor.name);
      return;
    }
    if (value instanceof ParamBase) return; // a bare param — renders to its own ref
    if (isEnvPick(value)) {
      // Descend into EVERY branch (the union over all envs): a branch holding a
      // step-referencing marker contributes its ordering edge in every env's
      // artifact. Conservative ordering is correct ordering — an edge from an
      // unpicked branch can only move a step earlier, never break a reference.
      for (const branch of Object.values(value.values)) scan(branch);
      return;
    }
    if (isRenderableRef(value)) {
      for (const id of extractStepIds(value.render({ env: "" }))) classify(id);
      return;
    }
    if (isRawRef(value) || isRawExpr(value) || isResolvable(value)) return; // resolver — no step ref
    if (Array.isArray(value)) {
      for (const v of value) scan(v);
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) scan(v);
    }
  };
  for (const input of inputs) scan(input);
  return { derives, steps };
}

/**
 * Collect every `ParamRef` instance in a value tree — the identity trail the
 * unreachable-derive warning is attributed by. A param's `.ref` is memoized
 * (one instance per param), so the ref inside a derive's inputs IS the ref in
 * the owning template's field map — identity, not name, ties them.
 */
function collectParamRefs(value: unknown, into: Set<ParamRef>): void {
  if (value instanceof ParamRef) {
    into.add(value);
    return;
  }
  if (isDeriveHandle(value)) return; // another derive's inputs are attributed on their own
  if (isEnvPick(value)) {
    for (const branch of Object.values(value.values)) collectParamRefs(branch, into);
    return;
  }
  if (isRawRef(value) || isRawExpr(value) || isResolvable(value)) return;
  if (Array.isArray(value)) {
    for (const v of value) collectParamRefs(v, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectParamRefs(v, into);
  }
}

/**
 * Whether an unreachable derive belongs to THIS template's form: every param ref
 * among its inputs is one of the form's own refs (object identity — see
 * `collectParamRefs`). A derive naming a foreign param is another template's,
 * so it is skipped here (that template's own compile reports it). A derive
 * naming NO params cannot be attributed and stays vacuously true — warned by
 * every compiling template, deliberately: ambiguous-but-loud beats a silent
 * drop (the ADR's silent-to-loud rule).
 */
function attributableToForm(d: DeriveDescriptor, ownRefs: ReadonlySet<unknown>): boolean {
  const refs = new Set<ParamRef>();
  for (const input of Object.values(d.inputs)) collectParamRefs(input, refs);
  for (const ref of refs) {
    if (!ownRefs.has(ref)) return false;
  }
  return true;
}

/**
 * Build the `roadiehq:utils:jsonata` step for one derive: `data:` from `inputs`
 * (each rendered as a reference by the normal compile pass), `expression:` from
 * the transpiled lambda.
 */
function deriveStep(descriptor: DeriveDescriptor): Step {
  // The inputs are markers/refs/literals — all `InputValue`s at runtime (the
  // `derive` signature accepts an `InputValue`-shaped map); the normal compile
  // pass renders each into `data:` as a `${{ … }}` reference.
  const data = { ...descriptor.inputs } as Record<string, InputValue>;
  return {
    id: descriptor.name,
    name: descriptor.stepName,
    action: "roadiehq:utils:jsonata",
    input: { data, expression: descriptor.expr.jsonata },
  };
}

/**
 * Order the combined graph of manual steps and reachable derives topologically.
 * Manual steps keep their declaration order (a chain of precedence edges); each
 * derive is placed after everything it references. Kahn's algorithm; among ready
 * nodes a ready DERIVE is emitted before a pending manual step (so a derive lands
 * just before the step that consumes it), manual steps break ties by declaration
 * order and derives by discovery order. A leftover set is a cycle — thrown, named.
 */
function topoOrder(manualSteps: Step[], reachable: Map<string, DeriveDescriptor>): Step[] {
  const manualIds = new Set<string>();
  for (const s of manualSteps) if (s.id !== undefined) manualIds.add(s.id);

  // Nodes: manual steps (keyed `m:<id|index>`) and derives (keyed `d:<name>`).
  interface Node {
    key: string;
    kind: "manual" | "derive";
    order: number; // declaration index (manual) / discovery index (derive)
    step: Step;
  }
  const nodes = new Map<string, Node>();
  const manualKey = (s: Step, i: number): string => `m:${s.id ?? `#${i}`}`;
  const idToManualKey = new Map<string, string>();
  manualSteps.forEach((s, i) => {
    const key = manualKey(s, i);
    nodes.set(key, { key, kind: "manual", order: i, step: s });
    if (s.id !== undefined) idToManualKey.set(s.id, key);
  });
  let discovery = 0;
  for (const [name, d] of reachable) {
    nodes.set(`d:${name}`, { key: `d:${name}`, kind: "derive", order: discovery++, step: deriveStep(d) });
  }

  // Edges: u must precede v. Adjacency (u → set of v) + in-degree per node.
  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const key of nodes.keys()) {
    adj.set(key, new Set());
    indeg.set(key, 0);
  }
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const out = adj.get(from);
    if (!out || out.has(to)) return;
    out.add(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  };

  // Manual declaration-order chain.
  for (let i = 1; i < manualSteps.length; i++) {
    addEdge(manualKey(manualSteps[i - 1]!, i - 1), manualKey(manualSteps[i]!, i));
  }
  // A manual step that references a derive → that derive precedes it.
  manualSteps.forEach((s, i) => {
    const inputs: unknown[] = [];
    if (s.input !== undefined) inputs.push(s.input);
    if (s.if !== undefined) inputs.push(s.if);
    const deps = depsOf(inputs, reachable, manualIds);
    for (const dn of deps.derives) addEdge(`d:${dn}`, manualKey(s, i));
  });
  // Each derive: its referenced derives / manual steps precede it.
  for (const [name, d] of reachable) {
    const deps = depsOf(Object.values(d.inputs), reachable, manualIds);
    for (const dn of deps.derives) addEdge(`d:${dn}`, `d:${name}`);
    for (const sid of deps.steps) {
      const mk = idToManualKey.get(sid);
      if (mk) addEdge(mk, `d:${name}`);
    }
  }

  // Kahn's: pick the "smallest" ready node — a ready derive beats a manual step,
  // then order within kind. This yields the just-in-time interleaving.
  const readyBetter = (a: Node, b: Node): boolean => {
    if (a.kind !== b.kind) return a.kind === "derive"; // derive first
    return a.order < b.order;
  };
  const ready: Node[] = [];
  for (const node of nodes.values()) if ((indeg.get(node.key) ?? 0) === 0) ready.push(node);

  const ordered: Step[] = [];
  while (ready.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < ready.length; i++) if (readyBetter(ready[i]!, ready[bestIdx]!)) bestIdx = i;
    const node = ready.splice(bestIdx, 1)[0]!;
    ordered.push(node.step);
    for (const to of adj.get(node.key) ?? []) {
      const next = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, next);
      if (next === 0) ready.push(nodes.get(to)!);
    }
  }

  if (ordered.length !== nodes.size) {
    const leftover = [...nodes.keys()].filter((k) => (indeg.get(k) ?? 0) > 0).map((k) => k.replace(/^[md]:/, ""));
    throw new Error(
      `derive: dependency cycle among derived values / steps — no valid order exists for: ` +
        `${leftover.join(", ")}. A derive cannot (transitively) depend on itself.`,
    );
  }
  return ordered;
}

/**
 * Plan a template's steps: collect the derives reachable from the manual steps'
 * inputs/`if` and the `output`, materialize each as a `roadiehq:utils:jsonata`
 * step, and interleave them with the manual steps in topological order.
 *
 * ADDITIVE: a template referencing no derive handles returns its manual steps
 * unchanged (byte-for-byte), so existing emission is untouched. A declared but
 * unreachable derive is EXCLUDED from emission with a loud diagnostic (returned
 * in `diagnostics`, surfaced on `CompileResult.diagnostics`).
 *
 * `ownRefs` — the compiling template's own param `.ref` instances — scopes the
 * unreachable warning to THIS template's derives (see `attributableToForm`), so
 * a multi-template process never cross-contaminates diagnostics. Omitted (a
 * direct caller), every unreachable derive is reported.
 */
export function planDerives(
  manualSteps: Step[],
  output?: Record<string, unknown>,
  ownRefs?: ReadonlySet<unknown>,
): PlanResult {
  const roots: unknown[] = [];
  for (const step of manualSteps) {
    if (step.input !== undefined) roots.push(step.input);
    if (step.if !== undefined) roots.push(step.if);
  }
  if (output) roots.push(output);

  const reachable = collectReachable(roots);

  // The unreachable-derive warning: any declared derive not reached from a root,
  // attributed to this template by its param refs. Best-effort (process-registry
  // — see `declaredDerives`); never affects the YAML.
  const diagnostics: string[] = [];
  for (const d of declaredDerives) {
    if (reachable.has(d.name)) continue;
    if (ownRefs && !attributableToForm(d, ownRefs)) continue; // another template's derive
    diagnostics.push(
      `derive "${d.name}" is declared but not reachable from any step input, step \`if\`, or the ` +
        `output — it is NOT emitted. Reference its handle where the value is needed, or remove it.`,
    );
  }

  // No derives → the manual steps are the plan, untouched.
  if (reachable.size === 0) return { steps: manualSteps, diagnostics };

  // A derive name must not collide with a manual step id.
  const manualIds = new Set<string>();
  for (const s of manualSteps) if (s.id !== undefined) manualIds.add(s.id);
  for (const name of reachable.keys()) {
    if (manualIds.has(name)) {
      throw new Error(
        `derive: derived-value name "${name}" collides with a manual step id of the same name — ` +
          `each emitted step id is unique. Rename the derive or the step.`,
      );
    }
  }

  return { steps: topoOrder(manualSteps, reachable), diagnostics };
}
