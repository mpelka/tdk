// Multi-page parameters + conditional dependencies.
//
// A flat `params = {...}` map is a single Scaffolder form page. Real templates
// are **multi-page** with conditional fields. This module models that:
//
//   - `page({ title, properties, required?, uiOrder?, dependencies? })` — one
//     ordered form page. `spec.parameters` becomes the array of pages.
//   - `dep.when(controller, branches)` — a JSON-Schema `dependencies` entry:
//     "when field <controller> matches, reveal these properties (+ required)".
//     Branches are `dep.eq(v)` / `dep.oneOf([...]) ` / `dep.not(v)`, each
//     optionally carrying extra `properties`, `required`, and **nested**
//     `dependencies` (e.g. tier → Layered → topper → topper_text).
//
// Property names are bound from their map keys (same rule as flat `params`),
// recursively through branches, so a conditional field's `.ref` still works.

import type { JsonSchema, ParamMap, ShowWhen, ShowWhenValue } from "./params.ts";
import { ERROR_MESSAGE_KEY, ParamBase, requireParam } from "./params.ts";

/**
 * Merge a `field → required-failure message` map into an object schema as the
 * ajv-errors `errorMessage: { required: { … } }` fragment (issue #59). A field's
 * `required` failure fires on the PARENT object (not the field), so its authored
 * message must live here. No-op when the map is empty — a schema with no such
 * message stays byte-identical to before. Mutates `target`.
 */
export function applyRequiredErrorMessages(
  target: { [ERROR_MESSAGE_KEY]?: unknown },
  messages: Record<string, string>,
): void {
  if (Object.keys(messages).length === 0) return;
  target[ERROR_MESSAGE_KEY] = { required: messages };
}

/**
 * The body a conditional branch contributes when it matches: extra fields, an
 * explicit `required` list (else derived from the fields' `required` flags),
 * and optional nested dependencies.
 */
export interface BranchBody {
  /** Extra properties revealed when this branch matches. */
  properties?: ParamMap;
  /** Required field names. Defaults to the branch's `required: true` props. */
  required?: string[];
  /** Nested dependencies scoped to this branch (e.g. topper → topper_text). */
  dependencies?: Dependency[];
}

/** One `oneOf` branch: a match condition on the controller + a body. */
export interface Branch extends BranchBody {
  /** The match fragment placed on the controller field (`const`/`enum`/`not`). */
  match: JsonSchema;
}

/**
 * A `dependencies` entry: a controlling param and the ordered `oneOf` branches
 * keyed off its value. The controller's name is read lazily at build time.
 */
export class Dependency {
  constructor(
    readonly controller: ParamBase<unknown>,
    readonly branches: Branch[],
  ) {}
}

/** Builders for conditional dependencies. */
export const dep = {
  /** "When `controller`'s value matches one of `branches`, reveal its body." */
  when(controller: ParamBase<unknown>, branches: Branch[]): Dependency {
    return new Dependency(controller, branches);
  },
  /** Branch matched when the controller equals `value` (`const`). */
  eq(value: ShowWhenValue, body: BranchBody = {}): Branch {
    return { match: { const: value }, ...body };
  },
  /** Branch matched when the controller is one of `values` (`enum`). */
  oneOf(values: ShowWhenValue[], body: BranchBody = {}): Branch {
    return { match: { enum: values }, ...body };
  },
  /** Branch matched when the controller does NOT equal `value` (`not`/`const`). */
  not(value: ShowWhenValue, body: BranchBody = {}): Branch {
    return { match: { not: { const: value } }, ...body };
  },
};

/** A single form page, as authored. */
export interface PageInput {
  /** Page heading (`title`). */
  title: string;
  /** The page's fields (name → Param). */
  properties: ParamMap;
  /** Required field names. Defaults to the page's `required: true` props. */
  required?: string[];
  /** Explicit field render order (`ui:order`). May include `"*"`. */
  uiOrder?: string[];
  /** Conditional dependencies on this page's fields. */
  dependencies?: Dependency[];
  /**
   * Raw JSON-Schema `dependencies` merged VERBATIM into the page's compiled
   * `dependencies` object — an escape hatch for shapes TDK doesn't model.
   */
  rawDependencies?: Record<string, unknown>;
  /**
   * Raw JSON-Schema merged VERBATIM into the page object at the top level — for
   * `if`/`then`/`else`, `anyOf`, `allOf`, etc. that live beside `properties`.
   */
  rawSchema?: Record<string, unknown>;
}

/**
 * A COLOCATED page: a `PageInput` whose `properties` map preserves its precise
 * `Props` type (instead of widening to `ParamMap`). Produced by the
 * `page(title, props)` form so `defineTemplate` can infer a flat, typed `f`
 * field-ref map from the params declared inside each page. It IS a `PageInput`
 * (and so flows through `buildPage`/`bindPageNames` unchanged).
 */
export interface ColocatedPage<Props extends ParamMap = ParamMap> extends PageInput {
  properties: Props;
}

/**
 * Page-level options for the COLOCATED `page(title, props, opts)` form — the
 * page settings that live BESIDE the fields (which the object form carries as
 * top-level `PageInput` keys). Kept as an options object so further page-level
 * settings can be added later without growing the positional arity (or
 * disturbing the `Props` inference, which is read from the 2nd `props` arg).
 */
export interface PageOptions {
  /** Explicit field render order (`ui:order`). May include `"*"`. */
  uiOrder?: string[];
}

/** Identity helper that types a page literal. */
export function page(input: PageInput): PageInput;
/**
 * COLOCATED form: `page(title, props, opts?)` declares a page's fields inline
 * and preserves their precise types (for `defineTemplate`'s typed `f`
 * inference). The optional `opts` carries page-level settings (e.g. `uiOrder`)
 * that the object form passes as top-level keys — `uiOrder` flows to the
 * compiled `ui:order` EXACTLY as the object form's `page({ ..., uiOrder })`
 * does (both go through `buildPage`). Equivalent at runtime to
 * `page({ title, properties: props, ...opts })`.
 */
export function page<Props extends ParamMap>(title: string, props: Props, opts?: PageOptions): ColocatedPage<Props>;
export function page(a: PageInput | string, b?: ParamMap, opts?: PageOptions): PageInput {
  if (typeof a === "string") {
    const pg: PageInput = { title: a, properties: b ?? {} };
    if (opts?.uiOrder !== undefined) pg.uiOrder = opts.uiOrder;
    return pg;
  }
  return a;
}

/** A built page — a JSON-Schema object with Backstage `ui:*` keys. */
export interface PageObject {
  title: string;
  required?: string[];
  "ui:order"?: string[];
  properties: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  /** ajv-errors `{ required: { field: message } }` for required-field messages (#59). */
  errorMessage?: { required: Record<string, string> };
}

/** Bind a property map's params to their keys (idempotent). */
function bindMap(map: ParamMap): void {
  for (const [name, param] of Object.entries(map)) {
    requireParam(name, param).setName(name);
  }
}

/** Recursively bind every param name reachable through a page (pre-compile). */
export function bindPageNames(pages: PageInput[]): void {
  for (const pg of pages) {
    bindMap(pg.properties);
    if (pg.dependencies) bindDepNames(pg.dependencies);
  }
}

function bindDepNames(deps: Dependency[]): void {
  for (const d of deps) {
    for (const branch of d.branches) {
      if (branch.properties) bindMap(branch.properties);
      if (branch.dependencies) bindDepNames(branch.dependencies);
    }
  }
}

/** Build a property map into `{ properties, required, requiredMessages }`, binding names. */
function buildProperties(map: ParamMap): {
  properties: Record<string, unknown>;
  required: string[];
  /** field → its authored `required`-failure message, for the parent errorMessage. */
  requiredMessages: Record<string, string>;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const requiredMessages: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    const param = requireParam(name, value);
    param.setName(name);
    properties[name] = param.toSchema();
    if (param.required) required.push(name);
    if (param.requiredErrorMessage !== undefined) requiredMessages[name] = param.requiredErrorMessage;
  }
  return { properties, required, requiredMessages };
}

/** Build one `dependencies` map from a list of `Dependency`s. */
function buildDependencies(deps: Dependency[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of deps) {
    const name = d.controller.requireName();
    out[name] = { oneOf: d.branches.map((b) => buildBranch(name, b)) };
  }
  return out;
}

/** Build one `oneOf` branch object. */
function buildBranch(controllerName: string, branch: Branch): Record<string, unknown> {
  // The controller's match fragment is itself a property entry, listed first.
  const props: Record<string, unknown> = { [controllerName]: branch.match };
  const built = branch.properties ? buildProperties(branch.properties) : undefined;
  if (built) Object.assign(props, built.properties);
  // An explicit `required` wins; else derive from the branch's own props.
  const required = branch.required ?? built?.required ?? [];
  const out: Record<string, unknown> = { properties: props };
  if (required.length) out.required = required;
  if (branch.dependencies?.length) {
    out.dependencies = buildDependencies(branch.dependencies);
  }
  // A required field revealed in THIS branch fails against this branch's object
  // schema — so its authored required message lifts to the branch, not the page.
  // Scoped to the FINAL required list: an explicit `required` override can add
  // or drop fields, and a message for a failure that can't fire is dead weight.
  if (built) {
    const requiredSet = new Set(required);
    const scoped: Record<string, string> = {};
    for (const [name, message] of Object.entries(built.requiredMessages)) {
      if (requiredSet.has(name)) scoped[name] = message;
    }
    applyRequiredErrorMessages(out, scoped);
  }
  return out;
}

/** Options for `buildPage`. */
export interface BuildPageOptions {
  /**
   * Infer `ui:order` from the base fields' source order when the page has no
   * explicit `uiOrder` (ADR-0025 Decision 4 — the authoring-v2 surface). Off by
   * default, so a v1 page is emitted byte-for-byte as before.
   */
  inferUiOrder?: boolean;
}

/** Build one authored page into its emitted `PageObject`. */
export function buildPage(input: PageInput, opts: BuildPageOptions = {}): PageObject {
  // Partition the flat properties into BASE fields and `showWhen` CONDITIONAL
  // fields. Conditional fields are moved out of the base form and compiled into
  // the dependency tree; base fields stay on the page.
  const baseMap: ParamMap = {};
  const conditional: ConditionalField[] = [];
  for (const [name, value] of Object.entries(input.properties)) {
    const param = requireParam(name, value);
    param.setName(name);
    // Normalize ref-based conditions to the record form here (needs bound names,
    // which bindPageNames has already assigned across the whole page).
    const showWhen = param.resolveShowWhen();
    if (showWhen) {
      conditional.push({ name, param, showWhen });
      continue;
    }
    baseMap[name] = param;
  }

  const { properties, required, requiredMessages } = buildProperties(baseMap);
  const finalRequired = input.required ?? required;
  const out: PageObject = { title: input.title, properties };
  if (input.uiOrder?.length) {
    // An explicit uiOrder always wins (ADR-0025 Decision 4).
    out["ui:order"] = input.uiOrder;
  } else if (opts.inferUiOrder) {
    // v2 inference: the base fields in source order. Conditional fields live in
    // `dependencies`, not the root `properties`, so they are NOT listed (RJSF
    // requires ui:order to name exactly the root properties). Empty → omitted.
    const order = Object.keys(properties);
    if (order.length) out["ui:order"] = order;
  }
  if (finalRequired.length) out.required = finalRequired;

  // Lift base fields' `required` messages to the page object (where `required`
  // fails). Scoped to fields that are ACTUALLY required — an explicit page-level
  // `required` list can drop a field the param flagged, and a message for a
  // failure that can't fire would be dead weight.
  const requiredSet = new Set(finalRequired);
  const pageRequiredMessages: Record<string, string> = {};
  for (const [name, message] of Object.entries(requiredMessages)) {
    if (requiredSet.has(name)) pageRequiredMessages[name] = message;
  }
  if (Object.keys(pageRequiredMessages).length > 0) {
    out.errorMessage = { required: pageRequiredMessages };
  }

  // dependencies = dep.when + showWhen + rawDependencies. Each controller may
  // be driven by exactly ONE of the three — a collision used to let the later
  // source silently CLOBBER the earlier one's branches, so it throws instead.
  const deps: Record<string, unknown> = {};
  const depSource = new Map<string, string>();
  const mergeDeps = (source: string, entries: Record<string, unknown>) => {
    for (const [controller, value] of Object.entries(entries)) {
      const prior = depSource.get(controller);
      if (prior) {
        throw new Error(
          `page "${input.title}": controller "${controller}" has dependencies from both ${prior} and ` +
            `${source} — the later would silently overwrite the earlier. Express every branch of ` +
            `"${controller}" in ONE of dep.when / showWhen / rawDependencies.`,
        );
      }
      depSource.set(controller, source);
      deps[controller] = value;
    }
  };
  if (input.dependencies?.length) {
    mergeDeps("dep.when(...)", buildDependencies(input.dependencies));
  }
  if (conditional.length) {
    mergeDeps("showWhen", buildShowWhenDependencies(input.properties, conditional));
  }
  if (input.rawDependencies) mergeDeps("rawDependencies", input.rawDependencies);
  if (Object.keys(deps).length) out.dependencies = deps;

  // Raw top-level schema (if/then/else, anyOf, allOf, ...) merged verbatim.
  if (input.rawSchema) Object.assign(out, input.rawSchema);

  return out;
}

// ---------------------------------------------------------------------------
// `showWhen` → nested dependencies compiler.
//
// A flat property carrying `showWhen: { controller: value | value[] }` (multiple
// keys = AND, an array value = OR) is compiled here into the same nested
// `dependencies`/`oneOf` tree `dep.when` produces — but authored declaratively.
// Each controller contributes one branch PER value in its value set (its `enum`,
// or `[true, false]` for a boolean), so unrevealed values get empty branches.
// A field whose `showWhen` references a controller that is itself conditional
// auto-nests inside that controller's branch (ordered by nesting depth).
// ---------------------------------------------------------------------------

/** A page field that is revealed conditionally via `showWhen`. */
interface ConditionalField {
  name: string;
  param: ParamBase<unknown>;
  showWhen: ShowWhen;
}

/** A mutable branch node while the dependency tree is assembled. */
interface SwBranch {
  properties: Record<string, unknown>;
  required: string[];
  /** field → required-failure message, for this branch's `errorMessage.required`. */
  requiredMessages: Record<string, string>;
  /** Dependency nodes DEFINED within this branch (controller → node). */
  deps: Map<string, SwDep>;
}

/** A mutable dependency node: a controller and its per-value branches. */
interface SwDep {
  controller: string;
  valueOrder: ShowWhenValue[];
  byValue: Map<string, SwBranch>;
}

/** Compile a page's `showWhen` conditional fields into a `dependencies` object. */
function buildShowWhenDependencies(propsMap: ParamMap, conditional: ConditionalField[]): Record<string, unknown> {
  const root = new Map<string, SwDep>();

  // Nesting depth of a controller: 0 for a base field, else 1 + the deepest of
  // the controllers in its own `showWhen`. Drives outer→inner chain ordering.
  // A cyclic chain (a shows when b, b shows when a) has no reachable form —
  // it used to compile into mutually-nested unreachable branches; throw instead.
  const depthMemo = new Map<string, number>();
  const visiting: string[] = [];
  const depthOf = (name: string): number => {
    const cached = depthMemo.get(name);
    if (cached !== undefined) return cached;
    const cycleStart = visiting.indexOf(name);
    if (cycleStart !== -1) {
      throw new Error(`showWhen cycle: ${[...visiting.slice(cycleStart), name].join(" → ")}`);
    }
    visiting.push(name);
    const param = propsMap[name];
    const sw = param instanceof ParamBase ? param.resolveShowWhen() : undefined;
    const depth = sw ? 1 + Math.max(0, ...Object.keys(sw).map(depthOf)) : 0;
    visiting.pop();
    depthMemo.set(name, depth);
    return depth;
  };

  const ensureDep = (scope: Map<string, SwDep>, controller: string): SwDep => {
    const existing = scope.get(controller);
    if (existing) return existing;
    const ctrlParam = propsMap[controller];
    if (!(ctrlParam instanceof ParamBase)) {
      // Deliberate semantics: a reveal condition may only key off a field on the
      // SAME page. Each wizard page compiles to its OWN JSON-Schema object, and a
      // `dependencies` node can only reference a sibling property of that object —
      // the wire has no cross-page dependency. So a controller that is bound on
      // ANOTHER page (or nowhere) is rejected here rather than emitted as a
      // dangling dependency the form would ignore.
      throw new Error(
        `showWhen references controller "${controller}", which is not a property on this page. A ` +
          `dependency can only key off a field declared on the SAME page (each wizard page is its own ` +
          `object schema) — declare the controller on this page, or move both fields onto one page.`,
      );
    }
    const values = ctrlParam.valueSet();
    if (!values) {
      throw new Error(`showWhen controller "${controller}" has no value set (needs an enum, or a boolean type).`);
    }
    const byValue = new Map<string, SwBranch>();
    for (const v of values) {
      byValue.set(String(v), { properties: {}, required: [], requiredMessages: {}, deps: new Map() });
    }
    const dep: SwDep = { controller, valueOrder: values, byValue };
    scope.set(controller, dep);
    return dep;
  };

  // Prime every conditional field's depth up front. This is what actually
  // detects cycles: a field with a SINGLE controller never invokes the sort
  // comparator below, so lazily computing depths would skip the cycle check.
  for (const field of conditional) depthOf(field.name);

  for (const field of conditional) {
    // Order this field's controllers outer→inner by nesting depth, then expand
    // any array (OR) values into the cartesian set of single-value chains.
    const entries = Object.entries(field.showWhen).sort((a, b) => depthOf(a[0]) - depthOf(b[0]));
    let chains: Array<Array<[string, ShowWhenValue]>> = [[]];
    for (const [controller, value] of entries) {
      const values = Array.isArray(value) ? value : [value];
      const next: Array<Array<[string, ShowWhenValue]>> = [];
      for (const chain of chains) {
        for (const v of values) next.push([...chain, [controller, v]]);
      }
      chains = next;
    }

    for (const chain of chains) {
      let scope = root;
      let target: SwBranch | undefined;
      for (const [controller, value] of chain) {
        const dep = ensureDep(scope, controller);
        const branch = dep.byValue.get(String(value));
        if (!branch) {
          throw new Error(
            `showWhen value ${JSON.stringify(value)} is not in the value set of controller "${controller}" — [${dep.valueOrder.join(", ")}].`,
          );
        }
        target = branch;
        scope = branch.deps;
      }
      if (target) {
        target.properties[field.name] = field.param.toSchema();
        if (field.param.required && !target.required.includes(field.name)) {
          target.required.push(field.name);
          // A required conditional field fails against the branch it is revealed
          // in — its authored required message lifts to that branch's object.
          if (field.param.requiredErrorMessage !== undefined) {
            target.requiredMessages[field.name] = field.param.requiredErrorMessage;
          }
        }
      }
    }
  }

  return serializeSwDeps(root);
}

/** Serialize a controller→node map into a JSON-Schema `dependencies` object. */
function serializeSwDeps(deps: Map<string, SwDep>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, dep] of deps) {
    out[name] = {
      oneOf: dep.valueOrder.map((value) => serializeSwBranch(name, value, dep.byValue.get(String(value))!)),
    };
  }
  return out;
}

/** Serialize one per-value branch (controller match first, then revealed fields). */
function serializeSwBranch(controller: string, value: ShowWhenValue, branch: SwBranch): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [controller]: { const: value },
    ...branch.properties,
  };
  const out: Record<string, unknown> = { properties };
  if (branch.required.length) out.required = branch.required;
  applyRequiredErrorMessages(out, branch.requiredMessages);
  if (branch.deps.size) out.dependencies = serializeSwDeps(branch.deps);
  return out;
}
