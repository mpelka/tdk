// The migration MODEL — the contract that crosses the confidentiality wall
// (ADR-0026). A parser on the private side reads a legacy export and produces this
// plain-JSON document; the printer on this (public) side consumes it and emits
// idiomatic authoring-v2 source. The two halves never share code — only this model,
// as data, validated by `model.schema.json`.
//
// These TypeScript types are the SIBLING of the JSON Schema: every shape here has a
// `$defs` counterpart in `model.schema.json`, and `schema-parity.test.ts` pins the
// two together (a typed-valid fixture is schema-valid). Change one, change both.

/** The model dialect version — independent of the `@tdk/core` package version,
 *  because the model is a public contract the private parser depends on. */
export const MODEL_VERSION = "1";

/** A JSON scalar — the leaf of a `default`, `exampleValue`, or `literal`. */
export type ScalarValue = string | number | boolean;

/** Any JSON value (a default, an example, a literal). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object — a map of string keys to JSON values (the shape of `extraSpec`). */
export type JsonObject = { [key: string]: JsonValue };

/** The template META node — id, title, and the catalog descriptors. */
export interface TemplateMeta {
  /** The template id (`metadata.name` in the compiled entity). */
  id: string;
  /** The human title. */
  title: string;
  /** The one-line description. */
  description?: string;
  /** The Backstage entity `spec.type` (defaults to `service` when omitted). */
  type?: string;
  /** The catalog tags. */
  tags?: string[];
  /** The owning group/user. */
  owner?: string;
  /**
   * Custom top-level `spec` keys the DSL does not model — a free-form JSON object
   * emitted verbatim as `defineTemplate`'s `extraSpec` and merged into the compiled
   * entity's `spec`. The deliberate escape hatch for catalog metadata a legacy source
   * carried but TDK has no first-class field for. Unvalidated beyond "is an object"
   * (the printer emits its keys/values through the same faithful `lit()` encoding the
   * other safe positions use, so hostile characters round-trip rather than inject).
   */
  extraSpec?: JsonObject;
}

/** The question TYPES the model understands — one per `p.*` field builder. */
export type QuestionType = "string" | "choice" | "boolean" | "number" | "array" | "customField";

/**
 * A QUESTION — one form field. `name` is the source name (the const is derived from
 * it, see `naming.ts`); `page` is the page tag the printer groups into the pages
 * table of contents. `exampleValue` feeds fixture generation, so a migrated template
 * is born testable.
 */
export interface Question {
  /** The source name (unique across the model's questions). */
  name: string;
  /** The field type — maps to `p.string` / `p.choice` / … */
  type: QuestionType;
  /** The field title. */
  title?: string;
  /** The field description. */
  description?: string;
  /** For a `choice`: the value→label map (`enum`/`enumNames`). */
  options?: Record<string, string>;
  /** Whether the field is required. */
  required?: boolean;
  /** The field's default value. */
  default?: JsonValue;
  /** An example value — feeds the generated scenario fixture. */
  exampleValue?: JsonValue;
  /** The page tag this question belongs to (grouped into the pages TOC). */
  page: string;
  /** The field's visibility predicate (a restricted vocabulary; see `VisibleWhen`). */
  visibleWhen?: VisibleWhen;
  // --- Pass-through field options (emitted verbatim onto the `p.*` builder) ---
  /** A string `format` (e.g. `email`). */
  format?: string;
  /** A string `pattern`. */
  pattern?: string;
  /** A string `minLength`. */
  minLength?: number;
  /** A string `maxLength`. */
  maxLength?: number;
  /** A number `minimum`. */
  minimum?: number;
  /** A number `maximum`. */
  maximum?: number;
  /**
   * A `ui:field` — the Backstage custom field extension name (emitted as RJSF
   * `ui:field`, e.g. `CakePickerWithDefault`). Legal on ANY question type, mirroring
   * core, where `uiField` is a `BaseParamOptions` member every param accepts; a
   * `customField` question REQUIRES it.
   */
  uiField?: string;
  /** A `ui:widget`. */
  uiWidget?: string;
  /** A `ui:options` map. */
  uiOptions?: Record<string, JsonValue>;
  /**
   * For a `customField`: the JSON-Schema `type` of the custom field's value (e.g.
   * `object`), mapped to `p.customField`'s `type`. Only meaningful on a `customField`
   * question; core defaults it to `string` when omitted, so the printer emits it only
   * when set.
   */
  customType?: string;
  /** For an `array`: the items schema. */
  items?: JsonValue;
}

/**
 * The VISIBLE-WHEN predicate — a restricted vocabulary that mirrors the authoring
 * layer's `showWhen`: field equality, field membership, and an AND-chain. Nothing
 * outside this vocabulary is modelled; a cross-field OR or a computed condition goes
 * to the flagged channel instead (the model inherits the schema layer's limits on
 * purpose).
 */
export type VisibleWhen =
  | { field: string; is: ScalarValue }
  | { field: string; in: ScalarValue[] }
  | { all: VisibleWhen[] };

/**
 * The LOGIC IR — a small op set for computed values. Each shape maps to a fragment
 * of a `derive` lambda. The set is deliberately minimal; anything it cannot express
 * goes to the escape hatch (`ExpressionEscape`).
 */
export type LogicExpr =
  | { op: "fieldRef"; field: string }
  | { op: "literal"; value: JsonValue }
  | { op: "logicRef"; ref: string }
  | { op: "lookupRef"; ref: string }
  | { op: "concat"; parts: LogicExpr[] }
  | { op: "template"; template: string; bindings: Record<string, LogicExpr> }
  | { op: "conditional"; cases: ConditionalCase[]; else: LogicExpr }
  | { op: "listMap"; source: LogicExpr; as: string; body: LogicExpr };

/** One `when → then` arm of a `conditional` logic node. */
export interface ConditionalCase {
  when: VisibleWhen;
  then: LogicExpr;
}

/**
 * A NAMED logic node — a `LogicExpr` carrying a `name`, which becomes a `derive`
 * in the emitted source. Its inputs are the field/logic references the printer
 * collects by walking the IR.
 */
export type NamedLogic = LogicExpr & { name: string };

/**
 * The ESCAPE HATCH — for logic the IR cannot express. The printer emits the source
 * verbatim in the declared language, clearly flagged, and counts it in the report.
 * Never dropped in silence.
 */
export interface ExpressionEscape {
  name: string;
  kind: "expression";
  language: "jsonata" | "nunjucks" | "scaffolder";
  source: string;
}

/** A logic node — either a named IR expression or the verbatim escape hatch. */
export type LogicNode = NamedLogic | ExpressionEscape;

/**
 * A LOOKUP — an opaque, preserved reference to an external source. The printer emits
 * a flagged TODO stub (wired to the org's resolver convention when a mapping exists,
 * a placeholder otherwise). The semantics stay deliberately unresolved: the model
 * preserves the reference, it does not interpret it.
 */
export interface Lookup {
  /** The lookup name (the const is derived from it). */
  name: string;
  /** The lookup kind — the mapping key for a resolver convention. */
  kind: string;
  /** The external source string, preserved VERBATIM. */
  source: string;
  /** The lookup's parameters (references to questions/logic, or literals). */
  params?: Record<string, ValueRef>;
  /** A source location for the report (a JSON pointer into the legacy export). */
  at?: string;
}

/**
 * An EFFECT — a legacy submit-action. The printer maps each effect through the
 * org-supplied action mapping (a mapped effect becomes a pack helper call; an
 * unmapped one becomes a flagged direct `effect(...)`). `actionRef` is preserved
 * verbatim and is the mapping key.
 */
export interface Effect {
  /** The effect name — the emitted step id. */
  name: string;
  /** A coarse effect kind (a category; the report echoes it). */
  kind: string;
  /** The legacy action reference, preserved VERBATIM (the mapping key). */
  actionRef: string;
  /** The effect's input mapping (references to questions/logic/lookups, or literals). */
  inputs?: Record<string, ValueRef>;
  /** An optional run condition (compiles to the step `if:`). */
  when?: VisibleWhen;
  /** A source location for the report (used when the effect is flagged unmapped). */
  at?: string;
}

/**
 * A VALUE REFERENCE — the value in a mapping position (an effect input, a lookup
 * param, an output). One of: a name reference (`ref`, resolved across all named
 * producers), an explicit kind-asserting reference (`questionRef` / `logicRef` /
 * `lookupRef` / `effectRef`, with an optional output sub-`path`), a `literal`, or an
 * inline logic expression. The `ref` shorthand and the inline-`op` form both come
 * from the ADR's worked example; the explicit `*Ref` forms let a producer assert
 * intent when names collide across kinds (and `effectRef` reads an effect output).
 */
export type ValueRef =
  | { ref: string }
  | { questionRef: string }
  | { logicRef: string }
  | { lookupRef: string }
  | { effectRef: string; path?: string[] }
  | { literal: JsonValue }
  | LogicExpr;

/**
 * The migration MODEL document. `modelVersion` starts at `"1"` and is independent
 * of the TDK package version.
 */
export interface MigrationModel {
  /** The model dialect version (`"1"`). */
  modelVersion: string;
  /** The template meta node. */
  template: TemplateMeta;
  /** The form questions. */
  questions: Question[];
  /** The computed-value logic nodes. */
  logic?: LogicNode[];
  /** The external lookups. */
  lookups?: Lookup[];
  /** The submit-action effects. */
  effects?: Effect[];
  /** The template output map. When omitted, the printer emits a sensible default. */
  outputs?: Record<string, ValueRef>;
}

// ---------------------------------------------------------------------------
// The action / lookup MAPPING (org-supplied; the private side of the wall).
// ---------------------------------------------------------------------------

/** One imported identifier — the helper/marker name and the module it comes from. */
export interface ImportSpec {
  /** The imported identifier. */
  name: string;
  /** The module specifier (e.g. `./pack.ts`). */
  from: string;
}

/** How a legacy action maps to a pack helper — keyed by the effect's `actionRef`. */
export interface ActionMap {
  /** The pack helper to import and call (`helper(id, { inputs })`). */
  import: ImportSpec;
}

/** How a lookup kind maps to a resolver marker — keyed by the lookup's `kind`. */
export interface LookupMap {
  /** The resolver marker to import and call (`marker({ params })`). */
  import: ImportSpec;
}

/**
 * The action/lookup MAPPING the org supplies. Keeps the printer org-agnostic: it
 * knows nothing about any one legacy action or lookup, it looks each up here. Fully
 * optional — the printer is usable with NO mapping (every effect prints as a flagged
 * direct `effect(...)`, every lookup as a placeholder stub).
 */
export interface MigrationMapping {
  /** Legacy action `actionRef` → pack helper. */
  actions?: Record<string, ActionMap>;
  /** Lookup `kind` → resolver marker. */
  lookups?: Record<string, LookupMap>;
}
