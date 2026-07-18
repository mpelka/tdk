// Effects — `effect(id, action, opts)` (ADR-0025 Decision 3, phase 3b).
//
// An EFFECT is a side-effectful step (raise a ticket, provision an oven) declared
// as a dataflow node. Unlike a `derive` — which computes a value and is
// materialized by the compiler as a `roadiehq:utils:jsonata` step — an effect IS
// the author's own action step; `effect(...)` only wraps it in a typed HANDLE so
// its output can be consumed by other nodes and the template `output`.
//
// The handle exposes `.output`, a typed reference rooted at
// `${{ steps['<id>'].output }}` (NOT `.output.result` — that suffix is roadie's,
// for derives). Property access navigates: `ticket.output.body.url` renders
// `${{ steps['open-oven-ticket'].output.body.url }}`. The output SHAPE is the
// handle's type parameter `O`, so a pack helper declares it once
// (`effect<TicketOutput>(...)`) and every sub-ref is typed and wrong-type-checked.
//
// The guarded Proxy behind `.output` is the SHARED one (handle.ts) — the same
// identifier-only, injection-proof implementation `derive` uses; effects do not
// fork a second Proxy. Effects are collected and ordered by the SAME planner
// (`planDerives` with `chainManual: false`): every effect is a step, and reachable
// derives interleave; ordering is data-dependency first, then effects-list
// declaration order for peers, with `after:` for an explicit order-only edge.

import type { RawRef } from "./expr/index.ts";
import type { HandleSpec, ReservedSubRefKey } from "./handle.ts";
import { makeHandleProxy } from "./handle.ts";
import type { ShowWhenPredicate } from "./params.ts";
import { compileWhenExpr, ParamBase } from "./params.ts";
import type { InputValue, Step } from "./template.ts";

// ---------------------------------------------------------------------------
// The output handle — a result-typed marker with property sub-refs.
// ---------------------------------------------------------------------------

/**
 * The marker at the core of an effect OUTPUT handle: a `RawRef` (so it renders to
 * a Scaffolder expression wherever an `InputValue` is accepted) carrying the
 * step's output type `O`. A first-class `TypedMarker` kind (typed-input.ts) — an
 * output ref rendering the wrong type is rejected in a `TypedInputValue<V>` slot,
 * and `MarkerValue<EffectOutputMarker<O>>` recovers `O`.
 *
 * The two phantoms mirror `Ref`/`DeriveMarker`: both are REQUIRED, never optional,
 * so a bare object carrying neither can never pose as an `EffectOutputMarker<V>`
 * for every `V`. Neither exists at runtime — every output ref is a cast Proxy.
 */
export interface EffectOutputMarker<O> extends RawRef {
  /** Marker so `MarkerValue` and the walks detect an output ref structurally. */
  readonly __tdkEffectOutput: true;
  /** Phantom — carries the step's output type `O`. Never present at runtime. */
  readonly __tdkOutputType: O;
}

/**
 * The typed sub-refs an OBJECT-typed output exposes: one output ref per property,
 * so `ticket.output.body` is a ref to `steps['ticket'].output.body` carrying that
 * property's type. Optional properties are unwrapped (`NonNullable`). LIMITS match
 * the derive handle (see handle.ts `ReservedSubRefKey`): arrays expose no
 * per-element sub-refs; scalars none; a reserved-named property is not a sub-ref;
 * a segment must be a plain identifier (throws at access — the injection guard).
 */
type OutputSubRefs<O> = O extends readonly unknown[]
  ? unknown
  : O extends object
    ? { readonly [K in Exclude<keyof O, ReservedSubRefKey>]-?: OutputRef<NonNullable<O[K]>> }
    : unknown;

/**
 * A typed effect-output reference: the result-carrying marker plus its property
 * sub-refs. Returned by `EffectHandle.output` and every sub-ref access on an
 * object-typed output. Satisfies `TypedInputValue<O>` and `InputValue`, so it
 * drops into any step/effect input, a derive's inputs, or the template `output`.
 */
export type OutputRef<O> = EffectOutputMarker<O> & OutputSubRefs<O>;

// ---------------------------------------------------------------------------
// The effect handle.
// ---------------------------------------------------------------------------

/** The internal record behind one `effect(...)` — the step it will emit. */
interface EffectDescriptor {
  /** The step id (unique within a template; the reachability/ordering key). */
  readonly id: string;
  /** The action id, e.g. `bakery:raise-ticket`. */
  readonly action: string;
  /** The user-visible step `name` (Backstage run log). */
  readonly name?: string;
  /** The step input — param consts already normalized to their `.ref`. */
  readonly input?: Record<string, InputValue>;
  /** A raw run condition (`if:`), when authored directly rather than via `when`. */
  readonly if?: Step["if"];
  /**
   * The `.when(...)` / `when:` predicate — stored RAW and compiled to `if:` LATE,
   * in `effectToStep` (which runs at compile, after the template binds the param
   * names). A module-scope `effect(...).when(field.is(v))` references a field
   * whose name is bound only when `defineTemplate` processes its pages, so
   * compiling the predicate eagerly here would fail (ADR-0025 Decision 4).
   */
  readonly when?: ShowWhenPredicate | ShowWhenPredicate[];
  /** Effect ids this effect must run AFTER (order-only `after:` edges). */
  readonly afterIds: readonly string[];
}

/** The symbol under which an `EffectHandle` stores its descriptor. */
const EFFECT_INFO: unique symbol = Symbol("tdk.effect");

/**
 * A typed effect handle: identifies a side-effectful step and exposes its typed
 * `.output`. Referenced by identity in a v2 template's `effects: [...]` list and
 * in `after:` hints; its `.output.<key>` sub-refs are consumed anywhere a value
 * goes. `.when(...)` and `.after(...)` return a NEW handle (the graph stays
 * introspectable data — no mutation), so bind the result:
 * `const notify = raiseTicket(...).when(severity.is("urgent"))`.
 *
 * A class (not a plain object) on purpose: its members live on the prototype and
 * the descriptor under a symbol, so `Object.entries(handle)` is empty and the
 * handle is NOT structurally an `InputValue` — using the bare handle where a
 * value belongs is a type error, steering the author to `.output`.
 */
export class EffectHandle<O> {
  /** @internal The descriptor — read via the module's accessor functions. */
  readonly [EFFECT_INFO]: EffectDescriptor;

  /** @internal Construct via `effect(...)` / `rawEffect(...)`, not directly. */
  constructor(descriptor: EffectDescriptor) {
    this[EFFECT_INFO] = descriptor;
  }

  /**
   * The step's typed output, rooted at `${{ steps['<id>'].output }}`. Navigate
   * to a field: `ticket.output.body.url` renders
   * `${{ steps['<id>'].output.body.url }}`. Typed by `O`; a wrong-type use is
   * rejected in a `TypedInputValue<V>` slot.
   */
  get output(): OutputRef<O> {
    const id = this[EFFECT_INFO].id;
    const spec: HandleSpec = {
      flags: ["__tdkRawRef", "__tdkEffectOutput"],
      render: (subPath) => `\${{ steps['${id}'].output${subPath.map((s) => `.${s}`).join("")} }}`,
      meta: { effectId: id },
      label: `effect "${id}" output`,
      injectionHint: `Read the output with an explicit nj() expression instead, or expose an identifier-named field.`,
    };
    return makeHandleProxy(spec, []) as unknown as OutputRef<O>;
  }

  /**
   * Attach a run condition (`if:`) — the SAME typed predicates a field's
   * `showWhen` and `step()`'s `when` accept: `field.is(v)`, `field.in(...)`,
   * `all(...)` to AND, or `any(...)` to OR (cross-field OR is expressible in a
   * step condition — ADR-0025 §5 / issue #24). Returns a new handle; throws if a
   * condition is already set (declare visibility once).
   */
  when(pred: ShowWhenPredicate | ShowWhenPredicate[]): EffectHandle<O> {
    const d = this[EFFECT_INFO];
    if (d.if !== undefined || d.when !== undefined) {
      throw new Error(
        `effect "${d.id}": .when(...) but a run condition (if / when) is already set — ` +
          `declare an effect's condition once.`,
      );
    }
    // Store the predicate RAW; it is compiled to `if:` late (effectToStep), after
    // the template binds param names.
    return new EffectHandle<O>({ ...d, when: pred });
  }

  /**
   * Order this effect AFTER the given effects, WITHOUT a data dependency — the
   * explicit order-only edge (ADR-0025 §3). Peers with no data dependency
   * otherwise run in effects-list declaration order; `after:` overrides that.
   * Returns a new handle.
   */
  after(...effects: EffectHandle<unknown>[]): EffectHandle<O> {
    const d = this[EFFECT_INFO];
    const ids = effects.map((e) => e[EFFECT_INFO].id);
    return new EffectHandle<O>({ ...d, afterIds: [...d.afterIds, ...ids] });
  }
}

// ---------------------------------------------------------------------------
// The `effect` authoring surface.
// ---------------------------------------------------------------------------

/**
 * One effect input value: any `InputValue` (a literal, ref, `nj`/`jsonata`
 * marker, `derive` handle, or effect output ref — all already `InputValue`s) OR a
 * bare param CONST, which `effect(...)` normalizes to its `.ref`. This is the
 * value type a pack effect helper accepts, so an author can pass `bakeryCode`
 * directly (ADR-0025 Decision 3) rather than `bakeryCode.ref`.
 */
export type EffectInputValue = InputValue | ParamBase<unknown>;

/** An effect input map: values may be a param CONST (normalized to `.ref`) too. */
export type EffectInputs = Record<string, EffectInputValue>;

/** Options for `effect(...)`. */
export interface EffectOptions {
  /** The step input. A param const is normalized to its `.ref` (like `derive`). */
  input?: EffectInputs;
  /** The user-visible step `name` (Backstage run log). */
  name?: string;
  /**
   * Run condition sugar (`if:`) — `field.is(v)`, `field.in(...)`, `all(...)`,
   * or `any(...)`. Compiles via `compileWhenExpr`. Giving both `when` and `if`
   * throws (they say the same thing).
   */
  when?: ShowWhenPredicate | ShowWhenPredicate[];
  /** Raw run condition — the escape hatch when `when` can't express it. */
  if?: Step["if"];
  /** Effects this must run AFTER, with no data dependency (order-only edges). */
  after?: ReadonlyArray<EffectHandle<unknown>>;
}

/** Normalize an effect input map: a param CONST → its `.ref` (mirrors `derive`). */
function normalizeInput(input: EffectInputs): Record<string, InputValue> {
  const out: Record<string, InputValue> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = value instanceof ParamBase ? value.ref : (value as InputValue);
  }
  return out;
}

/** Reject giving both `if` and `when` (they say the same thing two ways). */
function assertOneCondition(id: string, opts: EffectOptions): void {
  if (opts.if !== undefined && opts.when !== undefined) {
    throw new Error(
      `effect "${id}": both \`if\` and \`when\` were given — \`when\` is sugar for \`if\`; supply exactly one.`,
    );
  }
}

/**
 * Declare a side-effectful step as a typed effect.
 *
 * ```ts
 * const ticket = effect<{ body: { url: string; id: string } }>(
 *   "open-oven-ticket",
 *   "bakery:raise-ticket",
 *   { input: { title: ticketTitle, site: bakeryCode } },
 * );
 * // ticket.output.body.url → ${{ steps['open-oven-ticket'].output.body.url }}
 * ```
 *
 * `O` is the step's declared output shape (the type parameter). A pack helper —
 * a `defineAction`-style factory — wraps this so its consumers write
 * `catalog.raiseTicket(id, args)` and receive the typed handle (see the
 * `examples/oven-support-v2` plugin for the pattern packs will use).
 */
export function effect<O = Record<string, unknown>>(
  id: string,
  action: string,
  opts: EffectOptions = {},
): EffectHandle<O> {
  assertOneCondition(id, opts);
  const descriptor: EffectDescriptor = {
    id,
    action,
    name: opts.name,
    input: opts.input ? normalizeInput(opts.input) : undefined,
    if: opts.if,
    when: opts.when,
    afterIds: (opts.after ?? []).map((e) => e[EFFECT_INFO].id),
  };
  return new EffectHandle<O>(descriptor);
}

/**
 * Wrap a pre-built `Step` as an effect — the v2 escape hatch for anything the
 * `effect(...)` sugar can't express (a step from a v1-style `defineAction`
 * helper, a hand-built object, an action with an unusual input shape). The step
 * keeps its id/action/name/input/if verbatim; `O` types its `.output`.
 *
 * ```ts
 * const provisioned = rawEffect<{ ovenId: string }>(provisionOven({ id: "provision", ... }));
 * ```
 */
export function rawEffect<O = unknown>(
  step: Step,
  opts: { after?: ReadonlyArray<EffectHandle<unknown>> } = {},
): EffectHandle<O> {
  if (step.id === undefined) {
    throw new Error(
      "rawEffect(step): the step needs an id — an effect is a named, reachable step (its output is " +
        "referenced by id). Give the step an id, or use effect(id, action, ...).",
    );
  }
  const descriptor: EffectDescriptor = {
    id: step.id,
    action: step.action,
    name: step.name,
    input: step.input,
    if: step.if,
    afterIds: (opts.after ?? []).map((e) => e[EFFECT_INFO].id),
  };
  return new EffectHandle<O>(descriptor);
}

// ---------------------------------------------------------------------------
// Accessors for the compiler (define.ts) — the descriptor stays encapsulated.
// ---------------------------------------------------------------------------

/** True for an effect handle. */
export function isEffectHandle(value: unknown): value is EffectHandle<unknown> {
  return value instanceof EffectHandle;
}

/**
 * The `Step` an effect emits (id/action/name/input/if). The `.when(...)`
 * predicate is compiled to `if:` HERE (via `compileWhenExpr`) — late, at compile,
 * after the template has bound its param names — so a module-scope
 * `effect(...).when(field.is(v))` resolves the controller's bound name correctly.
 */
export function effectToStep(handle: EffectHandle<unknown>): Step {
  const d = handle[EFFECT_INFO];
  const step: Step = { id: d.id, action: d.action };
  if (d.name !== undefined) step.name = d.name;
  if (d.input !== undefined) step.input = d.input;
  const ifValue = d.when !== undefined ? compileWhenExpr(d.when) : d.if;
  if (ifValue !== undefined) step.if = ifValue;
  return step;
}

/**
 * The `after:` precedence edges of a set of effects, as `[fromId, toId]` pairs
 * (fromId precedes toId) — fed to the planner's `extraEdges`. An `after:` id that
 * is not itself an effect in the list adds no edge (the planner drops it).
 */
export function effectAfterEdges(handles: readonly EffectHandle<unknown>[]): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const h of handles) {
    const d = h[EFFECT_INFO];
    for (const fromId of d.afterIds) edges.push([fromId, d.id]);
  }
  return edges;
}
