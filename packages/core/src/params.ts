// Template parameters.
//
// `p.*` helpers describe typed inputs that become the Scaffolder parameter
// form (a JSON Schema). Each param:
//   - emits the right JSON-Schema fragment (type, title, pattern, enum, ...),
//   - carries TS type info via a phantom `_type` field (for M2/authoring),
//   - exposes `.ref`, a RawRef that emits `${{ parameters.<name> }}`,
//   - records whether it is `required` (collected into schema.required).
//
// A param does not know its own name at construction time; `Template` assigns
// it from the key in the `params` object at compile time (see template.ts).

import type { RawRef, RefResolver } from "./expr/index.ts";

/** A JSON-Schema fragment for a single parameter (Scaffolder property). */
export type JsonSchema = Record<string, unknown>;

/**
 * Guard `toSchema`'s deep clone. Two value classes get past the compile-time
 * marker walk: a nested `Param` loses its prototype in `structuredClone` and
 * carries no `__tdk*` key, so it clones into garbage the walk cannot see; an
 * expression/ref holds functions, so the clone dies with a pathless
 * `DataCloneError`. Reject both here, naming the schema path.
 */
function assertSchemaCloneSafe(value: unknown, path: string): void {
  if (value instanceof Param) {
    throw new Error(
      `param schema holds a Param at ${path} — params cannot nest inside uiOptions/defaults. ` +
        `Use a literal, or interpolate the value with .ref in a step input.`,
    );
  }
  if (typeof value === "function") {
    throw new Error(`param schema holds a function at ${path} — schemas are static JSON; use a literal.`);
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertSchemaCloneSafe(v, `${path}[${i}]`);
    return;
  }
  const marked = Object.keys(value).some((k) => k.startsWith("__tdk"));
  if (marked) {
    // A marker object (ref/env.pick/resolvable/expr). Cloneable ones survive
    // the clone and the compile-time marker walk rejects them with a
    // full-entity JSON path — leave those alone. But expression kinds carry
    // functions, which would kill structuredClone with a pathless
    // DataCloneError before the walk runs — reject those here instead.
    const hasFn = Object.values(value).some((v) => typeof v === "function");
    if (hasFn) {
      throw new Error(
        `param schema holds an expression at ${path} — jsonata()/nj() cannot live inside a ` +
          `param's schema (Backstage never evaluates them there); use a literal.`,
      );
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) assertSchemaCloneSafe(v, `${path}.${k}`);
}

/** A value a `showWhen` rule can match a controller field against. */
export type ShowWhenValue = string | number | boolean;

/**
 * A declarative reveal condition on a property: `controllerName → value(s)`.
 * Multiple keys are AND-ed; an array value is OR-ed. At compile this is compiled to
 * the nested JSON-Schema `dependencies`/`oneOf` tree (see pages.ts) — a readable
 * front-end for `dep.when`.
 */
export type ShowWhen = Record<string, ShowWhenValue | ShowWhenValue[]>;

/**
 * A ref-based reveal condition: `controller.is(v)` / `controller.in(a, b)`. Unlike
 * the record form's controller STRING, this carries the controller Param INSTANCE,
 * so `p.enum`/`p.boolean` controllers literal-check the value in the editor and the
 * unknown-controller failure mode is gone (compile resolves the bound name). A
 * single value is AND-matched; several values (`.in`) are OR-matched — identical to
 * the record form's scalar vs array.
 */
export class ShowWhenCondition {
  readonly __tdkShowWhen = true as const;
  constructor(
    /** The controller param this condition tests. Named late (its bound key). */
    readonly controller: Param<unknown>,
    /** The value(s) that reveal the field — one is AND, several are OR. */
    readonly values: ShowWhenValue[],
  ) {}
}

/** A `showWhen` authored either as the record form or as ref-based condition(s). */
export type ShowWhenInput = ShowWhen | ShowWhenCondition | ShowWhenCondition[];

/**
 * AND-compose ref-based conditions — the marker mirror of the record form's
 * multiple keys. `all(a.is("x"), b.is(true))` reveals a field only when BOTH hold,
 * exactly as `{ a: "x", b: true }` does. A single condition needs no `all(...)`:
 * pass it to `showWhen` directly.
 */
export function all(...conditions: ShowWhenCondition[]): ShowWhenCondition[] {
  return conditions;
}

/** True for a ref-based condition marker (vs the plain record form). */
function isShowWhenCondition(value: unknown): value is ShowWhenCondition {
  return value instanceof ShowWhenCondition;
}

/**
 * Normalize an authored `showWhen` (record form, a single condition, or an
 * `all(...)` list) into the record form pages.ts compiles. Ref-based conditions
 * resolve each controller's BOUND name — so the marker survives renaming the
 * property key, and a marker naming a param NOT on the same form throws here
 * (loud, pointed) rather than silently emitting an unbound dependency.
 */
export function normalizeShowWhen(input: ShowWhenInput): ShowWhen {
  const conditions = isShowWhenCondition(input) ? [input] : Array.isArray(input) ? input : undefined;
  if (!conditions) return input as ShowWhen;
  const out: ShowWhen = {};
  for (const cond of conditions) {
    const name = cond.controller.boundName;
    if (name === undefined) {
      throw new Error(
        "showWhen condition references a param that is not part of this form/page — declare the " +
          "controller as a property on the same page (its .ref/.is resolve from its bound name).",
      );
    }
    if (name in out) {
      throw new Error(
        `showWhen names controller "${name}" twice — combine its values into one .in(${cond.values
          .map((v) => JSON.stringify(v))
          .join(", ")}) instead of repeating the controller.`,
      );
    }
    out[name] = cond.values.length === 1 ? cond.values[0]! : cond.values;
  }
  return out;
}

/** Options common to all params. `required` is collected, not emitted inline. */
export interface BaseParamOptions<T> {
  title?: string;
  description?: string;
  required?: boolean;
  default?: T;
  /** Backstage UI field hint, e.g. "CakePickerWithDefault". Emitted as `ui:field`. */
  uiField?: string;
  /** RJSF widget override, e.g. "radio" / "textarea". Emitted as `ui:widget`. */
  uiWidget?: string;
  /** Placeholder text for the input. Emitted as `ui:placeholder`. */
  uiPlaceholder?: string;
  /** Arbitrary uiSchema options for the field. Emitted as `ui:options`. */
  uiOptions?: Record<string, unknown>;
  /**
   * Reveal this field only when controller field(s) match — compiled to nested
   * `dependencies`/`oneOf` at compile. Build-time only; never emitted as schema.
   *
   * Author it as ref-based condition(s) — `orderType.is("wedding")`, or
   * `all(orderType.is("wedding"), topper.is(true))` to AND them — so the editor
   * literal-checks the value; or as the inline record shorthand
   * `{ orderType: "wedding" }` (backed by the compile check). Both compile alike.
   */
  showWhen?: ShowWhenInput;
  /**
   * Human validation message(s), emitted as the ajv-errors `errorMessage` keyword
   * (issue #59). Replaces ajv's raw phrasing ("must match pattern …", "must have
   * required property …") wherever ajv-errors is enabled — the form preview and
   * Backstage's own RJSF both render it.
   *
   * Two forms:
   *   - a STRING — one message covering EVERY keyword failure of this field,
   *     `required` included. `errorMessage: "Enter a valid email."` reads whether
   *     the field is empty or malformed. The most common case.
   *   - a keyword-keyed OBJECT — a message per keyword: `{ pattern, format,
   *     minLength, minimum, enum, required, … }`. A `required` key here is peeled
   *     off to the parent object schema (where required actually fails); the rest
   *     stay on the field. Missing keywords fall back to ajv's default text.
   *
   * A `required` message (from either form) applies only when the field is also
   * `required: true` — otherwise there is no required failure to relabel.
   */
  errorMessage?: string | Record<string, string>;
}

/**
 * The `errorMessage` keyword name (ajv-errors). One constant so the emit sites in
 * params.ts (property level) and pages.ts (parent `required` level) stay in sync.
 */
export const ERROR_MESSAGE_KEY = "errorMessage" as const;

/**
 * The two halves of an authored `errorMessage`: the `property` part that lives on
 * the field's own schema (covers its keyword failures), and the `required`
 * message that must live on the PARENT object schema (where `required` fails).
 * Either half may be absent.
 */
export interface SplitErrorMessage {
  /** The `errorMessage` value emitted on the field (string or keyword object). */
  property?: string | Record<string, string>;
  /** The message for THIS field's `required` failure, lifted to the parent. */
  required?: string;
}

/**
 * Split an authored `errorMessage` into its field-level and parent-level parts.
 *
 *   - a STRING covers every keyword AND (when the field is required) the required
 *     failure: it goes on the field verbatim and is ALSO returned as `required`.
 *   - an OBJECT is emitted on the field with its `required` key removed; that key
 *     (if present) is returned as `required` for the parent.
 *
 * `required` is only surfaced when `isRequired` — a message for a failure that
 * cannot fire is dropped so no parent `errorMessage.required` entry is emitted.
 */
export function splitErrorMessage(
  errorMessage: string | Record<string, string> | undefined,
  isRequired: boolean,
): SplitErrorMessage {
  if (errorMessage === undefined) return {};
  if (typeof errorMessage === "string") {
    return { property: errorMessage, required: isRequired ? errorMessage : undefined };
  }
  const { required, ...rest } = errorMessage;
  const out: SplitErrorMessage = {};
  if (Object.keys(rest).length > 0) out.property = rest;
  if (isRequired && required !== undefined) out.required = required;
  return out;
}

export interface StringParamOptions extends BaseParamOptions<string> {
  pattern?: string;
  enum?: string[];
  /** Display labels for `enum` values (parallel array). Emitted as `enumNames`. */
  enumNames?: string[];
  minLength?: number;
  maxLength?: number;
  format?: string;
}

export interface NumberParamOptions extends BaseParamOptions<number> {
  minimum?: number;
  maximum?: number;
  enum?: number[];
  /** Display labels for `enum` values (parallel array). Emitted as `enumNames`. */
  enumNames?: string[];
}

export type BooleanParamOptions = BaseParamOptions<boolean>;

export interface EnumParamOptions<V extends string> extends BaseParamOptions<V> {
  enum: readonly V[];
  /** Display labels for `enum` values (parallel array). Emitted as `enumNames`. */
  enumNames?: string[];
}

export interface ArrayParamOptions<T> extends BaseParamOptions<T[]> {
  /** Schema fragment for array items. Defaults to `{ type: "string" }`. */
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

/**
 * A parameter ref — interpolated into `raw` expressions or used as a step-input
 * value. Renders to `${{ parameters.<name> }}`. The name is bound late by
 * `Template` once it knows the param's key.
 */
export class ParamRef implements RawRef {
  readonly __tdkRawRef = true as const;
  constructor(private readonly param: Param<unknown>) {}
  render(_resolve: RefResolver): string {
    return `\${{ parameters.${this.param.requireName()} }}`;
  }
  /** The literal expression string, env-independent. */
  toString(): string {
    return this.render({ env: "" });
  }
}

/**
 * Base class for all params. Holds the JSON-Schema fragment and required flag,
 * carries the phantom TS type, and lazily exposes `.ref`.
 */
export abstract class Param<T> {
  /** Phantom — carries the TS value type. Never read at runtime. */
  declare readonly _type: T;
  /** Whether this param goes into the schema's `required` array. */
  readonly required: boolean;
  /** Assigned by `Template` from the key in `params`. */
  private name?: string;
  private _ref?: ParamRef;

  /**
   * Reveal condition AS AUTHORED (record form, a single condition, or an
   * `all(...)` list), if any. Read `resolveShowWhen()` for the normalized record
   * the compiler consumes — it needs bound names, so it can't run at construction.
   */
  readonly showWhen?: ShowWhenInput;

  /**
   * The authored `required`-failure message, if any — lifted from `errorMessage`
   * to the PARENT object schema during page/branch assembly (where `required`
   * actually fails; see pages.ts). Computed UNCONDITIONALLY from a string
   * `errorMessage` (or an object's `required` key): whether it applies is the
   * ASSEMBLY's call, gated by the FINAL required list — a page-level
   * `required: [...]` override can make a field required that the param itself
   * did not flag (and vice versa). Never emitted on the field itself.
   */
  readonly requiredErrorMessage?: string;

  protected constructor(
    private readonly schema: JsonSchema,
    required: boolean | undefined,
    showWhen?: ShowWhenInput,
    errorMessage?: string | Record<string, string>,
  ) {
    this.required = required === true;
    this.showWhen = showWhen;
    // `isRequired: true` deliberately — assembly decides applicability from the
    // FINAL required list (see the field's doc above).
    this.requiredErrorMessage = splitErrorMessage(errorMessage, true).required;
  }

  /**
   * This param as a ref-based `showWhen` condition — `orderType.is("wedding")`.
   * The value is literal-checked against the param's own type, so a typo
   * (`orderType.is("weding")` on a `p.enum`) is a TS error in the editor. Carries
   * the Param INSTANCE; the controller name resolves at compile from its bound key.
   */
  is(value: T): ShowWhenCondition {
    return new ShowWhenCondition(this as Param<unknown>, [value as ShowWhenValue]);
  }

  /**
   * This param as an OR condition — `orderType.in("custom", "wedding")` reveals
   * the field in ANY of those branches, compiling identically to the record form's
   * array value `{ orderType: ["custom", "wedding"] }`.
   */
  in(...values: T[]): ShowWhenCondition {
    return new ShowWhenCondition(this as Param<unknown>, values as ShowWhenValue[]);
  }

  /**
   * The normalized `showWhen` record the compiler consumes, or `undefined` if this
   * param has no reveal condition. Ref-based conditions resolve their controller's
   * bound name here (throwing if it is not part of the form) — the record form
   * passes through unchanged. Call only after names are bound.
   */
  resolveShowWhen(): ShowWhen | undefined {
    return this.showWhen === undefined ? undefined : normalizeShowWhen(this.showWhen);
  }

  /**
   * Bind the param's name (its key in the template's `params` / a page's
   * `properties`). Idempotent for the SAME name (a fragment page reused across
   * templates re-binds its params to the same keys); rebinding to a DIFFERENT
   * name throws — one instance under two keys would silently render every
   * `.ref` as the LAST key bound.
   */
  setName(name: string): void {
    if (this.name !== undefined && this.name !== name) {
      throw new Error(
        `Param already bound to "${this.name}" cannot be re-bound to "${name}". A Param instance may ` +
          `appear under exactly one property name (its .ref renders from it) — create a separate p.* ` +
          `instance for "${name}".`,
      );
    }
    this.name = name;
  }

  /** The bound property name, or `undefined` before `setName` has run. */
  get boundName(): string | undefined {
    return this.name;
  }

  requireName(): string {
    if (this.name === undefined) {
      throw new Error(
        "Param used before its name was assigned. Params must be declared in a Template's `params` object so compile can name them.",
      );
    }
    return this.name;
  }

  /** A RawRef that emits `${{ parameters.<name> }}`. */
  get ref(): ParamRef {
    if (!this._ref) this._ref = new ParamRef(this);
    return this._ref;
  }

  /**
   * The JSON-Schema fragment for this param (a Scaffolder property). A DEEP
   * clone: a shallow copy let nested objects (enum arrays, ui:options, …) be
   * shared across artifacts — cross-artifact mutation, and YAML anchors/aliases
   * (`&a1`/`*a1`) whenever the same object appeared twice in one document.
   */
  toSchema(): JsonSchema {
    assertSchemaCloneSafe(this.schema, "$");
    return structuredClone(this.schema);
  }

  /**
   * The controller's value set, used by `showWhen` to enumerate dependency
   * branches: the `enum` values, or `[true, false]` for a boolean. `undefined`
   * for a free-form field (which therefore can't be a `showWhen` controller).
   */
  valueSet(): ShowWhenValue[] | undefined {
    if (Array.isArray(this.schema.enum)) {
      return this.schema.enum as ShowWhenValue[];
    }
    if (this.schema.type === "boolean") return [true, false];
    return undefined;
  }
}

/**
 * `enumNames` is a parallel display-label array for `enum` — a length mismatch
 * silently mislabels (or hides) options in the rendered form, so it throws.
 */
function checkEnumNames(kind: string, opts?: { enum?: readonly unknown[]; enumNames?: string[] }): void {
  if (!opts?.enumNames) return;
  if (!opts.enum) {
    throw new Error(`${kind}: enumNames requires enum — the labels must parallel a value list.`);
  }
  if (opts.enumNames.length !== opts.enum.length) {
    throw new Error(
      `${kind}: enumNames has ${opts.enumNames.length} label(s) for ${opts.enum.length} enum value(s) — ` +
        `the arrays must be parallel (value ↔ label).`,
    );
  }
}

function buildSchema(type: string, opts: object | undefined, extraKeys: string[]): JsonSchema {
  const schema: JsonSchema = { type };
  if (!opts) return schema;
  const o = opts as Record<string, unknown>;
  if (o.title !== undefined) schema.title = o.title;
  if (o.description !== undefined) schema.description = o.description;
  if (o.default !== undefined) schema.default = o.default;
  if (o.enumNames !== undefined) schema.enumNames = o.enumNames;
  if (o.uiField !== undefined) schema["ui:field"] = o.uiField;
  if (o.uiWidget !== undefined) schema["ui:widget"] = o.uiWidget;
  if (o.uiPlaceholder !== undefined) schema["ui:placeholder"] = o.uiPlaceholder;
  if (o.uiOptions !== undefined) schema["ui:options"] = o.uiOptions;
  for (const key of extraKeys) {
    if (o[key] !== undefined) schema[key] = o[key];
  }
  // errorMessage last — a trailing keyword reads well in the emitted YAML, after
  // the validation keywords (pattern/format/…) it relabels. Only the FIELD-level
  // part goes here; a `required` message is lifted to the parent object schema
  // during page/branch assembly (see `Param.requiredErrorMessage`).
  const errorProperty = splitErrorMessage(
    o.errorMessage as string | Record<string, string> | undefined,
    false,
  ).property;
  if (errorProperty !== undefined) schema[ERROR_MESSAGE_KEY] = errorProperty;
  return schema;
}

class StringParam extends Param<string> {
  constructor(opts?: StringParamOptions) {
    checkEnumNames("p.string", opts);
    super(
      buildSchema("string", opts, ["pattern", "enum", "minLength", "maxLength", "format"]),
      opts?.required,
      opts?.showWhen,
      opts?.errorMessage,
    );
  }
}

class NumberParam extends Param<number> {
  constructor(opts?: NumberParamOptions) {
    checkEnumNames("p.number", opts);
    super(
      buildSchema("number", opts, ["minimum", "maximum", "enum"]),
      opts?.required,
      opts?.showWhen,
      opts?.errorMessage,
    );
  }
}

class BooleanParam extends Param<boolean> {
  constructor(opts?: BooleanParamOptions) {
    super(buildSchema("boolean", opts, []), opts?.required, opts?.showWhen, opts?.errorMessage);
  }
}

class EnumParam<V extends string> extends Param<V> {
  constructor(opts: EnumParamOptions<V>) {
    checkEnumNames("p.enum", opts);
    const schema = buildSchema("string", opts, []);
    schema.enum = [...opts.enum];
    super(schema, opts.required, opts.showWhen, opts.errorMessage);
  }
}

class ArrayParam<T> extends Param<T[]> {
  constructor(opts?: ArrayParamOptions<T>) {
    const schema = buildSchema("array", opts, ["minItems", "maxItems"]);
    schema.items = opts?.items ?? { type: "string" };
    super(schema, opts?.required, opts?.showWhen, opts?.errorMessage);
  }
}

/**
 * A param built from a pre-assembled JSON-Schema fragment. `p.customField` (and
 * the consumer field helpers built on it via `defineField`) construct the exact
 * `ui:field` + `ui:options` shape Backstage expects and wrap it here.
 */
class CustomParam<T> extends Param<T> {
  // biome-ignore lint/complexity/noUselessConstructor: re-declares the base's PROTECTED constructor as public so the p.* field-type helpers can `new CustomParam(...)`
  constructor(
    schema: JsonSchema,
    required: boolean | undefined,
    showWhen?: ShowWhenInput,
    errorMessage?: string | Record<string, string>,
  ) {
    super(schema, required, showWhen, errorMessage);
  }
}

/**
 * Generic custom-field options for `p.customField` — the escape hatch for any
 * Backstage custom field type (e.g. `CakePickerWithDefault`). `uiField` and
 * `uiOptions` are emitted verbatim as `ui:field` / `ui:options`.
 */
export interface CustomFieldOptions extends BaseParamOptions<unknown> {
  /** The Backstage custom field name, emitted as `ui:field`. */
  uiField: string;
  /** JSON-Schema `type` of the underlying value. Defaults to `"string"`. */
  type?: string;
}

/**
 * A string param constrained to a fixed set of values. Pass the values as a
 * bare array for the common case — optionally with extra options (`title`,
 * `required`, `showWhen`, and `enumNames` for value/label pairs) — or pass the
 * full options object. The `extra` argument belongs to the ARRAY form only
 * (the overloads reject it beside an options object), but a JS caller who
 * passes both anyway gets them merged, the options object winning.
 *
 * ```ts
 * p.enum(["Low", "High"]);                                  // values only
 * p.enum(["Low", "High"], { title: "Priority", required: true });
 * p.enum(["L", "H"], { enumNames: ["Low", "High"] });       // value/label
 * p.enum({ enum: ["L", "H"], enumNames: ["Low", "High"] }); // full object form
 * ```
 */
function enumParam<const V extends string>(values: readonly V[], extra?: Omit<EnumParamOptions<V>, "enum">): Param<V>;
function enumParam<const V extends string>(opts: EnumParamOptions<V>): Param<V>;
function enumParam<const V extends string>(
  opts: readonly V[] | EnumParamOptions<V>,
  extra?: Omit<EnumParamOptions<V>, "enum">,
): Param<V> {
  const resolved = (Array.isArray(opts) ? { ...extra, enum: opts } : { ...extra, ...opts }) as EnumParamOptions<V>;
  return new EnumParam(resolved);
}

/**
 * Parameter constructors. Each returns a `Param<T>` whose `.ref` emits
 * `${{ parameters.<name> }}` and whose `.toSchema()` is a JSON-Schema fragment.
 */
export const p = {
  string(opts?: StringParamOptions): Param<string> {
    return new StringParam(opts);
  },
  number(opts?: NumberParamOptions): Param<number> {
    return new NumberParam(opts);
  },
  boolean(opts?: BooleanParamOptions): Param<boolean> {
    return new BooleanParam(opts);
  },
  enum: enumParam,
  array<T = string>(opts?: ArrayParamOptions<T>): Param<T[]> {
    return new ArrayParam<T>(opts);
  },

  /**
   * Generic custom-field escape hatch. Emits `ui:field` (from `uiField`) and
   * `ui:options` (from `uiOptions`) verbatim — e.g. `CakePickerWithDefault`.
   *
   * ```ts
   * p.customField({
   *   title: "Cake Code", required: true,
   *   uiField: "CakePickerWithDefault",
   *   uiOptions: { path: "bakery-catalog/...", valueSelector: "metadata.name" },
   * });
   * ```
   */
  customField(opts: CustomFieldOptions): Param<unknown> {
    // buildSchema already emits ui:field (from uiField), ui:options, and the
    // field-level errorMessage; pass errorMessage on so the required message lifts.
    const schema = buildSchema(opts.type ?? "string", opts, []);
    return new CustomParam<unknown>(schema, opts.required, opts.showWhen, opts.errorMessage);
  },
};

/** A map of param name → Param. The shape a Template's `params` field takes. */
export type ParamMap = Record<string, Param<unknown>>;

/**
 * Assert an authored property value is a `Param`. Anything else (a raw schema
 * object, a string, …) used to be SILENTLY DROPPED from the compiled form —
 * now it throws, pointing at the `p.*` helpers.
 */
export function requireParam(name: string, value: unknown): Param<unknown> {
  if (value instanceof Param) return value;
  throw new Error(
    `property "${name}" is not a Param — wrap it in a p.* helper ` +
      `(p.string / p.enum / p.boolean / …, or p.customField for a custom field type).`,
  );
}

export { Param as ParamBase };
