// Functional template API ("Option C") — colocated params + inferred typed refs.
//
// The way authors write a template (per ADR-0002, `class … extends Template` is no
// longer an authoring surface — `Template` is internal). Authors call
// `defineTemplate({...})` with params declared INSIDE each page (colocated, via
// the `page(title, props)` form), and `steps`/`output` receive a flat, typed map
// `f` of every param's `.ref`:
//
//   export default defineTemplate({
//     id: "cake-order", title: "Cake Order", type: "service",
//     parameters: [
//       page("Cake", { flavor: p.enum({ enum: ["Vanilla", "Chocolate"] }) }),
//       page("Extras", { notes: p.string({ uiWidget: "textarea" }) }),
//     ],
//     steps:  (f) => [step("order", "bakery:place", { input: { flavor: f.flavor } })],
//     output: (f) => ({ link: f.flavor }),   // optional; same inferred `f`
//   });
//
// `f.<name>` IS the param's `.ref` (a `RawRef` rendering `${{ parameters.<name> }}`,
// so it's usable anywhere an `InputValue` is) and carries the param's `T` so it
// stays typed downstream. The result is a normal `Template` instance, so
// `compile`/`execute`/`compileAll`/`toTemplate` consume it unchanged.
//
// `parameters` also accepts the FLAT single-page form — a bare props object
// instead of an array of pages — which compiles to a single JSON-Schema object
// (`spec.parameters: { properties, required }`), exactly like a class `params`:
//
//   export const OrderCake = defineTemplate({
//     id: "order-cake", title: "Order Cake", type: "service",
//     parameters: { bakeryCode: p.string({ required: true }), cakeName: p.string() },
//     steps:  (f) => [step("place", "bakery:place", { input: { name: f.cakeName } })],
//   });

import type { ColocatedPage, PageInput } from "./pages.ts";
import { bindPageNames } from "./pages.ts";
import type { ParamBase, ParamMap, ParamRef } from "./params.ts";
import { requireParam } from "./params.ts";
import type { BuiltForm, InputValue, Lifecycle, LoadContext, PrepareOptions, Step } from "./template.ts";
import { Template } from "./template.ts";

// ---------------------------------------------------------------------------
// Typed field refs.
// ---------------------------------------------------------------------------

/**
 * A param's `.ref` typed with the param's value type `T`. It is a `ParamRef`
 * (and therefore a `RawRef`/`InputValue`, rendering `${{ parameters.<name> }}`)
 * plus a phantom carrying `T`, so downstream typed uses see the param's type.
 * The phantom is never present at runtime.
 */
export interface Ref<T> extends ParamRef {
  /**
   * Phantom — carries the param's value type. Never present at runtime (every
   * `Ref` is a cast `ParamRef`; see `bindParameters`). REQUIRED, not optional,
   * deliberately: with an optional phantom the bare `ParamRef` base — the
   * public `.ref` getter's return type — was structurally assignable to
   * `Ref<V>` for EVERY `V` (a missing optional property satisfies every
   * instantiation), which let an untyped ref through every `TypedInputValue<V>`
   * slot (issue #15). Required, the bare base matches no instantiation, so only
   * a genuinely typed `Ref<T>` carries a result type downstream.
   */
  readonly __tdkRefType: T;
}

/** Distribute a union into an intersection (`A | B` → `A & B`). */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** The precise `Props` map declared inside one (colocated) page. */
type PropsOf<P> = P extends { properties: infer Props extends ParamMap } ? Props : never;

/** The value type `T` carried by a `Param<T>`. */
type ParamValueOf<P> = P extends ParamBase<infer T> ? T : never;

/** Merge every page's props into one flat `{ name: Param }` map. */
type MergedProps<Pages extends readonly unknown[]> = UnionToIntersection<PropsOf<Pages[number]>>;

/** Map a flat props object to its `{ name: Ref<T> }` field-ref map. */
type RefsOf<Props> = {
  [K in keyof Props]: Ref<ParamValueOf<Props[K]>>;
};

/**
 * The flat, typed field-ref map handed to `steps`/`output`: every param name
 * mapped to its `Ref<T>`. Branches on the `parameters` shape:
 *   - an array of colocated pages → every param across all pages (merged), or
 *   - a bare props object (the flat single-page form) → its own keys.
 */
export type FieldRefs<P> = P extends readonly ColocatedPage[] ? RefsOf<MergedProps<P>> : RefsOf<P>;

/** The props map behind either `parameters` shape (pages array → merged props). */
type PropsShape<P> = P extends readonly ColocatedPage[] ? MergedProps<P> : P;

/**
 * The fixture `parameters` value shape for a template authored with params `P`:
 * every param name mapped to its value type, all optional (a scenario may
 * supply any subset). Carried by `TypedTemplate.__tdkParams` so `execute()`
 * can type a fixture against the template. Purely a type — never at runtime.
 */
export type ParamValues<P> = {
  [K in keyof PropsShape<P>]?: ParamValueOf<PropsShape<P>[K]>;
};

/**
 * A `Template` carrying a phantom of its params' fixture value shape (see
 * `ParamValues`), so `execute()` can infer the fixture type from the template.
 * The phantom property never exists at runtime — zero cost.
 */
export type TypedTemplate<PV = Record<string, unknown>> = Template & {
  /** Phantom — the fixture `parameters` shape. Never present at runtime. */
  readonly __tdkParams?: PV;
};

// ---------------------------------------------------------------------------
// `step` helper.
// ---------------------------------------------------------------------------

/** Options for the `step(...)` helper (everything past `id`/`action`). */
export interface StepOptions {
  /** Step input map; values may be refs / raw / jsonata / nj / literals. */
  input?: Record<string, InputValue>;
  /** Human-readable step name (`name`). */
  name?: string;
  /** Templated run condition (`if`). */
  if?: Step["if"];
}

/**
 * Build a `Step`. The functional-API counterpart to authoring a step object
 * literal in a class `build()`:
 *
 * ```ts
 * step("order", "bakery:place", { input: { flavor: f.flavor } });
 * // => { id: "order", action: "bakery:place", input: { flavor: <ref> } }
 * ```
 */
export function step(id: string, action: string, opts: StepOptions = {}): Step {
  const out: Step = { id, action };
  if (opts.name !== undefined) out.name = opts.name;
  if (opts.input !== undefined) out.input = opts.input;
  if (opts.if !== undefined) out.if = opts.if;
  return out;
}

// ---------------------------------------------------------------------------
// `defineTemplate`.
// ---------------------------------------------------------------------------

/**
 * A compile-time data loader — TDK's `generateStaticParams`. Runs once per target
 * env at compile time; whatever it returns is handed to `parameters`, so live data
 * (catalog entries, AD groups, …) bakes into the emitted YAML as real options. May
 * be sync or async. In tests the network is faked (MSW) or the result is injected
 * directly (a fixture's `loaded`), so `load` itself stays plain and unmocked.
 */
export type LoadFn<L> = (ctx: LoadContext) => L | Promise<L>;

/** The metadata fields common to every `defineTemplate` config. */
interface DefineTemplateBase {
  /** `metadata.name` — unique in the catalog. */
  id: string;
  /** `metadata.title`. */
  title: string;
  /** `metadata.description`. */
  description?: string;
  /** `spec.type`, e.g. "service". */
  type: string;
  /** `metadata.tags`. */
  tags?: string[];
  /** `spec.owner`. */
  owner?: string;
  /** Drives `restrictedToUsers` while state !== "ga". */
  lifecycle?: Lifecycle;
  /** Extra top-level `spec` keys merged verbatim (the escape hatch). */
  extraSpec?: Record<string, unknown>;
}

/**
 * The config accepted by `defineTemplate` WITHOUT a `load()`. `parameters` is the
 * form value itself, in EITHER shape:
 *   - an ordered array of colocated `page(title, props)` pages (params declared
 *     inside each) → compiled to `spec.parameters` as an array of pages, or
 *   - a bare props object `{ name: p.* }` (the flat single-page form) → compiled
 *     to a single JSON-Schema `{ properties, required }` object, like `params = {}`.
 */
export interface DefineTemplateConfig<P extends readonly ColocatedPage[] | ParamMap> extends DefineTemplateBase {
  /** The parameter form (an array of pages, or a flat props object). */
  parameters: P;
  /** Build the steps, given the flat typed field-ref map. */
  steps: (f: FieldRefs<P>) => Step[];
  /** Optional `spec.output`, given the same field-ref map. */
  output?: (f: FieldRefs<P>) => Record<string, InputValue>;
}

/**
 * The config accepted by `defineTemplate` WITH a `load()`. `load` fetches data at
 * compile time and `parameters` becomes a function of that (typed) data, so live
 * values bake into the form as real options. `steps`/`output` are unchanged — they
 * still receive only the field-ref map `f` (they act on what the user selected,
 * not on the loaded data).
 */
export interface DefineTemplateConfigWithLoad<P extends readonly ColocatedPage[] | ParamMap, L>
  extends DefineTemplateBase {
  /** Compile-time data loader (runs once per target env). */
  load: LoadFn<L>;
  /** Build the parameter form from the loaded data. */
  parameters: (data: L) => P;
  /** Build the steps, given the flat typed field-ref map. */
  steps: (f: FieldRefs<P>) => Step[];
  /** Optional `spec.output`, given the same field-ref map. */
  output?: (f: FieldRefs<P>) => Record<string, InputValue>;
}

/** Either `defineTemplate` config shape — what `DefinedTemplate` stores. */
type AnyDefineTemplateConfig<P extends readonly ColocatedPage[] | ParamMap, L> =
  | DefineTemplateConfig<P>
  | DefineTemplateConfigWithLoad<P, L>;

/**
 * Collect a flat `{ name: ParamRef }` map from the colocated pages, binding each
 * param's name from its property key (so its `.ref` renders correctly) and
 * asserting names are unique across pages (the field map is flat).
 */
function buildFieldRefs(pages: readonly PageInput[]): Record<string, ParamRef> {
  const refs: Record<string, ParamRef> = {};
  for (const pg of pages) {
    for (const [name, value] of Object.entries(pg.properties)) {
      const param = requireParam(name, value);
      if (Object.hasOwn(refs, name)) {
        throw new Error(
          `defineTemplate: duplicate parameter name "${name}" across pages. ` +
            `Parameter names must be unique because steps/output receive a flat field map.`,
        );
      }
      param.setName(name);
      refs[name] = param.ref;
    }
  }
  return refs;
}

/**
 * Collect a flat `{ name: ParamRef }` map from a bare props object (the flat
 * single-page form), binding each param's name from its key. Keys in one object
 * are unique, so (unlike the multi-page case) no cross-page dup check is needed.
 */
function buildFlatFieldRefs(params: ParamMap): Record<string, ParamRef> {
  const refs: Record<string, ParamRef> = {};
  for (const [name, value] of Object.entries(params)) {
    const param = requireParam(name, value);
    param.setName(name);
    refs[name] = param.ref;
  }
  return refs;
}

/**
 * A concrete `Template` built from a `defineTemplate` config. Maps the
 * `parameters` onto either `Template.pages` (the colocated-pages array → a pages
 * ARRAY) or `Template.params` (a bare props object → a single JSON-Schema
 * object), and implements `build()`/`output` by invoking the config's
 * `steps`/`output` with the inferred field-ref map — so the whole existing
 * compile/execute pipeline consumes it unchanged.
 *
 * Without a `load()` the form is env-independent: it is bound ONCE onto the
 * instance in the constructor (the synchronous compile path keeps working).
 * With a `load()` the form depends on awaited env-specific data, so `prepare`
 * builds and RETURNS it per call as a value — never storing it on the
 * instance, so concurrent compiles for different envs can't cross-contaminate.
 */
class DefinedTemplate<P extends readonly ColocatedPage[] | ParamMap, L> extends Template {
  id: string;
  title: string;
  type: string;

  /** Whether the config declares a `load()` (the form is then env-dependent). */
  private readonly hasLoad: boolean;
  /** The bound field-ref map of the STATIC form; null when load() defers it. */
  private readonly staticRefs: FieldRefs<P> | null = null;
  /** Memoized loader promise keyed by env — one fetch per template × env. */
  private readonly loadCache = new Map<string, Promise<L>>();

  constructor(private readonly cfg: AnyDefineTemplateConfig<P, L>) {
    super();
    this.id = cfg.id;
    this.title = cfg.title;
    this.type = cfg.type;
    if (cfg.description !== undefined) this.description = cfg.description;
    if (cfg.tags !== undefined) this.tags = cfg.tags;
    if (cfg.owner !== undefined) this.owner = cfg.owner;
    if (cfg.lifecycle !== undefined) this.lifecycle = cfg.lifecycle;
    if (cfg.extraSpec !== undefined) this.extraSpec = cfg.extraSpec;
    this.hasLoad = "load" in cfg && typeof cfg.load === "function";
    if (!this.hasLoad) {
      // No load(): `parameters` is the form value. Bind it once onto the
      // instance — it is env-independent, so sharing it across compiles is safe.
      const bound = bindParameters<P>((cfg as DefineTemplateConfig<P>).parameters);
      this.params = bound.params;
      this.pages = bound.pages;
      this.staticRefs = bound.refs;
      if (cfg.output) this.output = cfg.output(bound.refs);
    }
  }

  override get requiresPreparation(): boolean {
    return this.hasLoad;
  }

  override async prepare(ctx: LoadContext, opts: PrepareOptions = {}): Promise<BuiltForm> {
    if (!this.hasLoad) return this.builtForm();
    const cfg = this.cfg as DefineTemplateConfigWithLoad<P, L>;
    // Use injected data (fixture-tier mock) if given; else run the (memoized) loader.
    const injected = opts.loaded !== undefined ? opts.loaded : opts.data;
    const data = (injected !== undefined ? injected : await this.load(ctx)) as L;
    // Build the form AS A VALUE — nothing is written to the instance, so two
    // concurrent prepares (test + prod) can never bake each other's data.
    const bound = bindParameters<P>(cfg.parameters(data));
    const form: BuiltForm = { params: bound.params, pages: bound.pages, steps: cfg.steps(bound.refs) };
    const output = cfg.output?.(bound.refs);
    if (output) form.output = output;
    return form;
  }

  /** Run `load()` once per env (memoized) — the `unstable_cache`-style seam. */
  private load(ctx: LoadContext): Promise<L> {
    const cached = this.loadCache.get(ctx.env);
    if (cached) return cached;
    const load = (this.cfg as DefineTemplateConfigWithLoad<P, L>).load;
    const pending = Promise.resolve(load(ctx));
    this.loadCache.set(ctx.env, pending);
    // A rejected load() must not poison the cache: evict, so the next compile
    // retries instead of replaying the failure forever.
    pending.catch(() => this.loadCache.delete(ctx.env));
    return pending;
  }

  build(): Step[] {
    if (!this.staticRefs) {
      throw new Error(
        `Template "${this.id}" declares load(); run it through the async compile path ` +
          `(compileResolved / compileAll / execute), not the synchronous compile().`,
      );
    }
    return this.cfg.steps(this.staticRefs);
  }
}

/**
 * Bind a concrete `parameters` value: an array → multi-page `pages` (branch
 * params included, via `bindPageNames`); a bare props object → the flat
 * `params` map. Returns the pieces plus the flat typed field-ref map.
 */
function bindParameters<P extends readonly ColocatedPage[] | ParamMap>(
  parameters: readonly ColocatedPage[] | ParamMap,
): { params: ParamMap; pages?: PageInput[]; refs: FieldRefs<P> } {
  if (Array.isArray(parameters)) {
    const pages = parameters as unknown as PageInput[];
    const refs = buildFieldRefs(pages) as unknown as FieldRefs<P>;
    bindPageNames(pages);
    return { params: {}, pages, refs };
  }
  const params = parameters as ParamMap;
  return { params, refs: buildFlatFieldRefs(params) as unknown as FieldRefs<P> };
}

/**
 * Author a template functionally (colocated params + inferred typed refs).
 * Returns a normal `Template` instance, accepted everywhere a class instance is
 * (`compile`/`execute`/`compileAll`/the CLI's `findTemplate`).
 *
 * With a `load()`: `parameters` is `(data) => form`, where `data` is the awaited
 * `load()` result (inferred). `load` runs at compile time via the async path
 * (`compileResolved`/`compileAll`/`execute`); the synchronous `compile` throws.
 *
 * Without `load()`: `parameters` is the form value — an array of colocated pages
 * (→ a pages array) or a bare props object (→ the flat single `{ properties,
 * required }` form). The `const` type parameter makes it infer precisely (a page
 * tuple, or the props' exact keys/types) so `f`'s names/types survive into
 * `steps`/`output`.
 *
 * The returned template is a `TypedTemplate` carrying a phantom of its params'
 * fixture value shape, so `execute(tpl, fixture)` type-checks the fixture's
 * `parameters` against the template's declared params.
 */
export function defineTemplate<const P extends readonly ColocatedPage[] | ParamMap, L>(
  cfg: DefineTemplateConfigWithLoad<P, L>,
): TypedTemplate<ParamValues<P>>;
export function defineTemplate<const P extends readonly ColocatedPage[] | ParamMap>(
  cfg: DefineTemplateConfig<P>,
): TypedTemplate<ParamValues<P>>;
export function defineTemplate<const P extends readonly ColocatedPage[] | ParamMap, L>(
  cfg: AnyDefineTemplateConfig<P, L>,
): Template {
  return new DefinedTemplate<P, L>(cfg);
}
