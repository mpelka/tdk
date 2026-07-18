// Core template model.
//
// A `Template` subclass is the typed, in-memory source for one Backstage
// Scaffolder template. Authors declare metadata fields, a `params` map, a
// `build()` returning steps, and an optional `output`. Compile turns this into a
// Backstage Template entity, once per deploy target.

import { planDerives } from "./derive.ts";
import type { EnvPick } from "./env.ts";
import type { RawExpr, RawRef } from "./expr/index.ts";
import type { JsonataExpr } from "./expr/jsonata/index.ts";
import type { NunjucksExpr } from "./expr/nunjucks/index.ts";
import type { Dependency, PageInput } from "./pages.ts";
import { bindPageNames } from "./pages.ts";
import type { ParamMap } from "./params.ts";
import { ParamBase } from "./params.ts";
import type { Resolvable } from "./resolve.ts";

/**
 * Compile-time context handed to a template's `load()` and to `prepare`. `env`
 * lets `load()` fetch env-specific data (a test catalog vs a prod one), so the
 * options baked into each env's YAML can legitimately differ.
 */
export interface LoadContext {
  /** The target Backstage env this compile is producing (any env name). */
  env: string;
}

/** Options for `prepare` — lets a caller inject pre-loaded data (mock tier 1). */
export interface PrepareOptions {
  /**
   * Pre-supplied `load()` result. When provided, `load()` is NOT called and this
   * data is used verbatim — the fixture-tier mock (a scenario carrying
   * `loaded: {…}`), keeping TDK agnostic about how data is faked.
   */
  loaded?: unknown;
  /** @deprecated Use `loaded` — same meaning; kept as a compat alias. */
  data?: unknown;
}

/**
 * Lifecycle state of a template. While the state is not `"ga"`, compile emits
 * `restrictedToUsers` under `spec` so only the named users can see/run it.
 */
export interface Lifecycle {
  state: "experimental" | "alpha" | "beta" | "uat" | "ga";
  /** Users allowed to run the template while state !== "ga". */
  restrictedToUsers?: string[];
}

/**
 * A value usable as a step input: a literal, a param ref, an env.pick, a `raw`
 * expression, or a transpiled `jsonata(...)` (JSONata) expression.
 */
export type InputValue =
  | string
  | number
  | boolean
  | null
  | RawExpr
  // `any` here is deliberate: a `JsonataExpr<Ctx, R>` for a SPECIFIC context is
  // not assignable to `JsonataExpr<unknown, unknown>` (the `fn` param is
  // contravariant in Ctx), so we accept any concrete instantiation.
  // biome-ignore lint/suspicious/noExplicitAny: variance — accept any concrete JsonataExpr<Ctx,R> (Ctx is contravariant in fn, so unknown won't accept a concrete instantiation)
  | JsonataExpr<any, any>
  // A compiled `nj(...)` Nunjucks expression (also a `RawRef`, listed for clarity).
  // biome-ignore lint/suspicious/noExplicitAny: variance — accept any concrete NunjucksExpr<Ctx,R> (Ctx is contravariant in fn, so unknown won't accept a concrete instantiation)
  | NunjucksExpr<any, any>
  | EnvPick<unknown>
  // A param's `.ref` (a `RawRef`) used directly as a step input / output value.
  // `compile`'s `resolveValue` renders any `RawRef` to `${{ parameters.<name> }}`.
  | RawRef
  // A deferred resolver marker (e.g. `person("Ada Lovelace")`) — replaced with a
  // concrete value by the async resolution pass in `compileResolved`/`compileAll`.
  | Resolvable
  | InputValue[]
  | { [key: string]: InputValue };

/**
 * Collect the `.ref` of every param a form declares — the flat map, every page's
 * properties, and the params inside `dep.when` branches (recursively). The set
 * scopes the unreachable-derive warning to the compiling template: a derive's
 * inputs carry these SAME memoized ref instances, so identity membership says
 * "this derive reads MY form" (see derive.ts `attributableToForm`).
 */
export function collectFormParamRefs(params: ParamMap, pages?: PageInput[]): Set<unknown> {
  const refs = new Set<unknown>();
  const addMap = (map: ParamMap): void => {
    for (const value of Object.values(map)) {
      if (value instanceof ParamBase) refs.add(value.ref);
    }
  };
  const walkDeps = (deps: Dependency[]): void => {
    for (const d of deps) {
      for (const branch of d.branches) {
        if (branch.properties) addMap(branch.properties);
        if (branch.dependencies) walkDeps(branch.dependencies);
      }
    }
  };
  addMap(params);
  for (const pg of pages ?? []) {
    addMap(pg.properties);
    if (pg.dependencies) walkDeps(pg.dependencies);
  }
  return refs;
}

/** A single scaffolder step as authored in `build()`. */
export interface Step {
  id?: string;
  name?: string;
  action: string;
  input?: Record<string, InputValue>;
  /**
   * Templated condition; a raw/expr/nj expression, a ref (e.g. a param's
   * `.ref` or an `env.pick`), a resolver marker, or a literal — compile
   * resolves it exactly like a step-input value.
   */
  // biome-ignore lint/suspicious/noExplicitAny: variance — accept any concrete Jsonata/Nunjucks expr instantiation (Ctx is contravariant in fn, so unknown won't accept it)
  if?: string | boolean | RawExpr | RawRef | Resolvable | JsonataExpr<any, any> | NunjucksExpr<any, any>;
}

/**
 * The BUILT form of a template for one compile: the concrete parameter form
 * (pages or the flat params map), the built steps, and the output map.
 * `prepare` returns it as a VALUE and `compile` consumes it as an argument, so
 * two concurrent compiles for different envs can never read each other's form
 * — there is no shared mutable form state on the template instance.
 */
export interface BuiltForm {
  /** The flat single-page param map (used when `pages` is absent/empty). */
  params: ParamMap;
  /** The multi-page form; when non-empty it wins over `params`. */
  pages?: PageInput[];
  /** The ordered scaffolder steps, built once per compile. */
  steps: Step[];
  /** The `spec.output` map, if any. */
  output?: Record<string, InputValue>;
  /**
   * Non-fatal compile diagnostics produced while building the form — e.g. a
   * declared-but-unreachable `derive`. Surfaced on `CompileResult.diagnostics`;
   * never affects the emitted YAML. Absent when there is nothing to report.
   */
  diagnostics?: string[];
}

/**
 * Base class for all templates. Subclasses set the metadata fields and
 * implement `build()`. Field types are intentionally permissive at the base so
 * subclasses can use `as const` literals freely.
 */
export abstract class Template {
  /** `metadata.name` — must be unique in the catalog. */
  abstract id: string;
  /** `metadata.title`. */
  abstract title: string;
  /** `metadata.description`. */
  description?: string;
  /** `spec.type`, e.g. "service", "website", "library". */
  abstract type: string;
  /** `metadata.tags`. */
  tags?: string[];
  /** `spec.owner`. */
  owner?: string;
  /** Drives `restrictedToUsers` while state !== "ga". */
  lifecycle?: Lifecycle;
  /** The Scaffolder parameter form, as a map of name → Param (single page). */
  params: ParamMap = {};
  /**
   * Multi-page parameter form. When set (non-empty), `spec.parameters` is
   * emitted as this ordered array of pages and the flat `params` map is ignored.
   */
  pages?: PageInput[];
  /**
   * Arbitrary extra top-level `spec` keys merged into the compiled spec —
   * the escape hatch for fields TDK doesn't model (e.g. an org-specific
   * `bakery_catalogue_metadata` key like `{ category_L1: "Signature Bakes" }`).
   */
  extraSpec?: Record<string, unknown>;
  /** `spec.output` — values may be raw expressions / refs / env picks. */
  output?: Record<string, InputValue>;

  /** Return the ordered list of scaffolder steps. */
  abstract build(): Step[];

  /**
   * Run compile-time data loading (the `load()` hook) and build this
   * template's form FOR the given target env, returned as a value (never
   * stored on the instance — see `BuiltForm`). On the base / for templates
   * without a `load()` this is the static `builtForm()`; `defineTemplate`
   * overrides it when `load` is declared. The async compile path
   * (`compileResolved`/`compileAll`/`execute`) awaits this and hands the form
   * to `compile`. Recomputes per call so a different `ctx.env` can yield
   * different baked options; the loader itself is memoized per env.
   * `opts.loaded`, when set, is used instead of calling `load()`.
   */
  async prepare(_ctx: LoadContext, _opts: PrepareOptions = {}): Promise<BuiltForm> {
    return this.builtForm();
  }

  /**
   * Build this template's form as a value, binding param names first. For a
   * class template the form is env-independent, so both `prepare` and the
   * synchronous `compile` read this. Templates whose form depends on `load()`
   * data never reach it via compile (`requiresPreparation` makes the sync path
   * throw; their `prepare` builds the form from the loaded data instead).
   */
  builtForm(): BuiltForm {
    this.bindParamNames();
    // Plan the steps: interleave any reachable `derive(...)` values (as roadie
    // jsonata steps) with the built manual steps, topologically. A template with
    // no derives gets its manual steps back unchanged (see `planDerives`). The
    // form's own param refs scope the unreachable-derive warning to THIS template.
    const ownRefs = collectFormParamRefs(this.params, this.pages);
    const { steps, diagnostics } = planDerives(this.build(), this.output, ownRefs);
    const form: BuiltForm = { params: this.params, pages: this.pages, steps, output: this.output };
    if (diagnostics.length) form.diagnostics = diagnostics;
    return form;
  }

  /**
   * True when this template declares a `load()`. The synchronous `compile`
   * always throws on such a template (its form isn't built until `load()`
   * runs), pointing callers at the async compile path, which threads the
   * prepared form through explicitly.
   */
  get requiresPreparation(): boolean {
    return false;
  }

  /**
   * Bind each param's name from its key in `params`. Idempotent. Called by
   * compile before reading `.ref`s so they emit `${{ parameters.<key> }}`.
   */
  bindParamNames(): void {
    for (const [name, param] of Object.entries(this.params)) {
      if (param instanceof ParamBase) {
        param.setName(name);
      }
    }
    if (this.pages?.length) {
      bindPageNames(this.pages);
    }
  }
}
