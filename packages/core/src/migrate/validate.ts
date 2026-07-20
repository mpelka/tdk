// `validateModel(doc)` — gate 0: the model validates against the published schema,
// PLUS the semantic checks the schema cannot express.
//
// The schema (ajv) catches shape errors. The semantic pass then catches the wiring
// errors: a reference to a name that was never declared, a duplicate name, a
// `visibleWhen` field that is not a question. Each is reported as a PATH-QUALITY
// message — `questions[3].visibleWhen.field: "sevrity" is not a declared question
// (did you mean "severity"?)` — with a nearest-name suggestion for the typo case.

import Ajv, { type ErrorObject } from "ajv";
import type {
  ConditionalCase,
  Effect,
  LogicExpr,
  LogicNode,
  Lookup,
  MigrationModel,
  Question,
  ValueRef,
  VisibleWhen,
} from "./model.ts";
import { modelSchema } from "./schema.ts";

/** One validation error, with the model PATH it sits at and a readable message. */
export interface ModelError {
  /** The path into the model (e.g. `questions[3].visibleWhen.field`). */
  path: string;
  /** The human-readable message (already includes any "did you mean" hint). */
  message: string;
}

/** The result of validating a model: `valid`, and the collected errors. */
export interface ValidateModelResult {
  valid: boolean;
  errors: ModelError[];
}

let cachedValidator: ReturnType<Ajv["compile"]> | undefined;

function schemaValidator(): ReturnType<Ajv["compile"]> {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(modelSchema());
  }
  return cachedValidator;
}

/** Turn an ajv JSON-pointer instancePath into the friendlier `a[0].b.c` form. */
function pointerToPath(pointer: string): string {
  if (!pointer) return "(root)";
  const segments = pointer.split("/").filter(Boolean);
  let out = "";
  for (const seg of segments) {
    if (/^[0-9]+$/.test(seg)) out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out || "(root)";
}

/** Render an ajv error as a `ModelError`. */
function fromAjvError(err: ErrorObject): ModelError {
  const path = pointerToPath(err.instancePath);
  const msg = err.message ?? "is invalid";
  // For an enum/const, name the allowed values; for additionalProperties, name the key.
  if (err.keyword === "additionalProperties") {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return { path, message: `unknown property "${extra}"` };
  }
  if (err.keyword === "enum") {
    const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues ?? [];
    return { path, message: `${msg} (${allowed.map((v) => JSON.stringify(v)).join(", ")})` };
  }
  return { path, message: msg };
}

// ---------------------------------------------------------------------------
// Nearest-name suggestions (Levenshtein).
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}

/** The nearest candidate to `target` within a small edit distance, or undefined. */
function nearest(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  const threshold = Math.max(2, Math.floor(target.length / 2));
  for (const c of candidates) {
    const d = levenshtein(target.toLowerCase(), c.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

/** Append a "did you mean" hint when a near candidate exists. */
function withSuggestion(message: string, target: string, candidates: Iterable<string>): string {
  const hint = nearest(target, candidates);
  return hint ? `${message} (did you mean "${hint}"?)` : message;
}

// ---------------------------------------------------------------------------
// The semantic pass.
// ---------------------------------------------------------------------------

interface NameSets {
  questions: Set<string>;
  logic: Set<string>;
  lookups: Set<string>;
  effects: Set<string>;
  all: Set<string>;
}

function collectNames(model: MigrationModel): NameSets {
  const questions = new Set((model.questions ?? []).map((q) => q.name));
  const logic = new Set((model.logic ?? []).map((n) => n.name));
  const lookups = new Set((model.lookups ?? []).map((l) => l.name));
  const effects = new Set((model.effects ?? []).map((e) => e.name));
  const all = new Set<string>([...questions, ...logic, ...lookups]);
  return { questions, logic, lookups, effects, all };
}

/** Report duplicate names within a kind, and any name reused across kinds. */
function checkDuplicates(model: MigrationModel, errors: ModelError[]): void {
  const kinds: Array<[string, string[]]> = [
    ["questions", (model.questions ?? []).map((q) => q.name)],
    ["logic", (model.logic ?? []).map((n) => n.name)],
    ["lookups", (model.lookups ?? []).map((l) => l.name)],
    ["effects", (model.effects ?? []).map((e) => e.name)],
  ];
  const seenGlobal = new Map<string, string>();
  for (const [kind, names] of kinds) {
    const seen = new Set<string>();
    names.forEach((name, i) => {
      if (seen.has(name)) {
        errors.push({ path: `${kind}[${i}].name`, message: `duplicate name "${name}" within ${kind}` });
      }
      seen.add(name);
      const priorKind = seenGlobal.get(name);
      if (priorKind && priorKind !== kind) {
        errors.push({
          path: `${kind}[${i}].name`,
          message: `name "${name}" is also declared in ${priorKind} — a { ref } to it would be ambiguous`,
        });
      }
      seenGlobal.set(name, kind);
    });
  }
}

/** Check a visibleWhen predicate: every `field` must be a declared question. */
function checkVisibleWhen(vw: VisibleWhen, path: string, names: NameSets, errors: ModelError[]): void {
  if ("all" in vw) {
    vw.all.forEach((sub, i) => {
      checkVisibleWhen(sub, `${path}.all[${i}]`, names, errors);
    });
    return;
  }
  if (!names.questions.has(vw.field)) {
    errors.push({
      path: `${path}.field`,
      message: withSuggestion(`"${vw.field}" is not a declared question`, vw.field, names.questions),
    });
  }
}

/** Check a logic IR expression's references. `locals` holds listMap iteration vars. */
function checkLogicExpr(
  expr: LogicExpr,
  path: string,
  names: NameSets,
  errors: ModelError[],
  locals: Set<string>,
): void {
  switch (expr.op) {
    case "fieldRef": {
      const head = expr.field.split(".")[0];
      if (locals.has(head)) return; // a listMap item reference
      if (!names.questions.has(expr.field)) {
        errors.push({
          path: `${path}.field`,
          message: withSuggestion(`"${expr.field}" is not a declared question`, expr.field, names.questions),
        });
      }
      return;
    }
    case "literal":
      return;
    case "logicRef":
      if (!names.logic.has(expr.ref)) {
        errors.push({
          path: `${path}.ref`,
          message: withSuggestion(`"${expr.ref}" is not a declared logic node`, expr.ref, names.logic),
        });
      }
      return;
    case "lookupRef":
      if (!names.lookups.has(expr.ref)) {
        errors.push({
          path: `${path}.ref`,
          message: withSuggestion(`"${expr.ref}" is not a declared lookup`, expr.ref, names.lookups),
        });
      }
      return;
    case "concat":
      expr.parts.forEach((p, i) => {
        checkLogicExpr(p, `${path}.parts[${i}]`, names, errors, locals);
      });
      return;
    case "template":
      for (const [key, sub] of Object.entries(expr.bindings)) {
        checkLogicExpr(sub, `${path}.bindings.${key}`, names, errors, locals);
      }
      return;
    case "conditional":
      expr.cases.forEach((c: ConditionalCase, i) => {
        checkVisibleWhen(c.when, `${path}.cases[${i}].when`, names, errors);
        checkLogicExpr(c.then, `${path}.cases[${i}].then`, names, errors, locals);
      });
      checkLogicExpr(expr.else, `${path}.else`, names, errors, locals);
      return;
    case "listMap": {
      checkLogicExpr(expr.source, `${path}.source`, names, errors, locals);
      const inner = new Set(locals);
      inner.add(expr.as);
      checkLogicExpr(expr.body, `${path}.body`, names, errors, inner);
      return;
    }
  }
}

/** Check a value reference (an effect input, a lookup param, an output). */
function checkValueRef(vref: ValueRef, path: string, names: NameSets, errors: ModelError[]): void {
  if ("ref" in vref) {
    if (!names.all.has(vref.ref)) {
      errors.push({
        path,
        message: withSuggestion(`"${vref.ref}" is not a declared question, logic node, or lookup`, vref.ref, names.all),
      });
    }
    return;
  }
  if ("questionRef" in vref) {
    if (!names.questions.has(vref.questionRef)) {
      errors.push({
        path,
        message: withSuggestion(`"${vref.questionRef}" is not a declared question`, vref.questionRef, names.questions),
      });
    }
    return;
  }
  if ("logicRef" in vref && !("op" in vref)) {
    if (!names.logic.has(vref.logicRef)) {
      errors.push({
        path,
        message: withSuggestion(`"${vref.logicRef}" is not a declared logic node`, vref.logicRef, names.logic),
      });
    }
    return;
  }
  if ("lookupRef" in vref) {
    if (!names.lookups.has(vref.lookupRef)) {
      errors.push({
        path,
        message: withSuggestion(`"${vref.lookupRef}" is not a declared lookup`, vref.lookupRef, names.lookups),
      });
    }
    return;
  }
  if ("effectRef" in vref) {
    if (!names.effects.has(vref.effectRef)) {
      errors.push({
        path,
        message: withSuggestion(`"${vref.effectRef}" is not a declared effect`, vref.effectRef, names.effects),
      });
    }
    return;
  }
  if ("literal" in vref) return;
  if ("op" in vref) {
    checkLogicExpr(vref as LogicExpr, path, names, errors, new Set());
  }
}

function semanticChecks(model: MigrationModel, errors: ModelError[]): void {
  const names = collectNames(model);

  checkDuplicates(model, errors);

  (model.questions ?? []).forEach((q: Question, i) => {
    if (q.visibleWhen) checkVisibleWhen(q.visibleWhen, `questions[${i}].visibleWhen`, names, errors);
  });

  (model.logic ?? []).forEach((node: LogicNode, i) => {
    if ("op" in node) checkLogicExpr(node, `logic[${i}]`, names, errors, new Set());
  });

  (model.lookups ?? []).forEach((l: Lookup, i) => {
    for (const [key, vref] of Object.entries(l.params ?? {})) {
      checkValueRef(vref, `lookups[${i}].params.${key}`, names, errors);
    }
  });

  (model.effects ?? []).forEach((e: Effect, i) => {
    for (const [key, vref] of Object.entries(e.inputs ?? {})) {
      checkValueRef(vref, `effects[${i}].inputs.${key}`, names, errors);
    }
    if (e.when) checkVisibleWhen(e.when, `effects[${i}].when`, names, errors);
  });

  for (const [key, vref] of Object.entries(model.outputs ?? {})) {
    checkValueRef(vref, `outputs.${key}`, names, errors);
  }
}

// ---------------------------------------------------------------------------
// Forbidden-character checks — the emitted-code injection guard.
//
// Model string fields flow into the printer's OUTPUT: names become identifiers and
// step ids, and `kind`/`source`/`actionRef` are interpolated into `//` comments and
// `raw` placeholders. A control character, a JS line terminator (\n \r U+2028 U+2029),
// or a backtick can break out of a comment or a template literal and inject code that
// still PARSES. The schema patterns reject these; this pass gives the producer the
// friendly, precise message that names the field and says what to strip. (Defense in
// depth also lives in the printer, which sanitizes every interpolation.)
//
// The scan covers exactly the fields that land in an UNSAFE position (an identifier, a
// step id, a `//` comment, a `raw` placeholder). It deliberately does NOT descend into
// the fields the printer emits through `lit()` — `default`, `exampleValue`, `options`,
// `uiOptions`, `items`, and `template.extraSpec` — because `lit()` renders every leaf
// with `JSON.stringify`, which faithfully escapes any character inside a double-quoted
// string. A newline or backtick there round-trips into the compiled spec, it cannot
// break out. So `extraSpec` is exempt from the strict name/id rules (it is the escape
// hatch, free-form by design) yet still emission-safe; `injection.test.ts` pins that a
// hostile extraSpec value both parses and round-trips.
// ---------------------------------------------------------------------------

/** A control character, DEL, or a JS line/paragraph separator. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the point (to reject them).
const CONTROL_OR_TERMINATOR = /[\u0000-\u001F\u007F\u2028\u2029]/;
/** The above, plus a backtick (names become identifiers/step ids). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the point (to reject them).
const NAME_FORBIDDEN = /[\u0000-\u001F\u007F\u2028\u2029`]/;
/** The above, plus path separators (a template id becomes a directory name). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the point (to reject them).
const ID_FORBIDDEN = /[\u0000-\u001F\u007F\u2028\u2029/\\]/;

const NAME_MSG =
  "contains a control character, line break, or backtick — a name becomes an identifier and step id, so use only printable single-line text";
const TEXT_MSG =
  "contains a control character or line break — this is emitted single-line; strip line breaks and control characters";
const ID_MSG =
  "contains a control character, line break, or path separator — a template id becomes a directory name; use printable single-line text without / or \\";

function checkForbiddenChars(doc: unknown, errors: ModelError[]): void {
  if (!doc || typeof doc !== "object") return;
  const model = doc as Record<string, unknown>;

  const name = (v: unknown, path: string) => {
    if (typeof v === "string" && NAME_FORBIDDEN.test(v)) errors.push({ path, message: NAME_MSG });
  };
  const text = (v: unknown, path: string) => {
    if (typeof v === "string" && CONTROL_OR_TERMINATOR.test(v)) errors.push({ path, message: TEXT_MSG });
  };

  const template = model.template as Record<string, unknown> | undefined;
  if (typeof template?.id === "string" && ID_FORBIDDEN.test(template.id)) {
    errors.push({ path: "template.id", message: ID_MSG });
  }

  if (Array.isArray(model.questions)) {
    model.questions.forEach((q, i) => {
      name((q as Record<string, unknown>)?.name, `questions[${i}].name`);
    });
  }
  if (Array.isArray(model.logic)) {
    model.logic.forEach((n, i) => {
      const node = n as Record<string, unknown>;
      name(node?.name, `logic[${i}].name`);
      // An escape-hatch `source` is deliberately allowed to be multi-line; the printer
      // splits it safely into comment lines. Only its NAME is an identifier.
    });
  }
  if (Array.isArray(model.lookups)) {
    model.lookups.forEach((l, i) => {
      const lk = l as Record<string, unknown>;
      name(lk?.name, `lookups[${i}].name`);
      text(lk?.kind, `lookups[${i}].kind`);
      text(lk?.source, `lookups[${i}].source`);
    });
  }
  if (Array.isArray(model.effects)) {
    model.effects.forEach((e, i) => {
      const ef = e as Record<string, unknown>;
      name(ef?.name, `effects[${i}].name`);
      text(ef?.kind, `effects[${i}].kind`);
      text(ef?.actionRef, `effects[${i}].actionRef`);
    });
  }
}

/**
 * Validate a migration model. The forbidden-character guard runs FIRST and always
 * (defensively, even on a malformed doc), so a producer gets the friendly injection
 * message. Then the JSON Schema runs; a schema-valid model additionally gets the
 * reference/semantic checks. Returns `{ valid, errors }`; format with
 * `formatModelErrors`.
 */
export function validateModel(doc: unknown): ValidateModelResult {
  const charErrors: ModelError[] = [];
  checkForbiddenChars(doc, charErrors);

  const validate = schemaValidator();
  const schemaOk = validate(doc) as boolean;
  if (!schemaOk) {
    // Drop ajv `pattern` errors — they duplicate the friendlier `charErrors` — and
    // surface the rest (missing fields, wrong types, unknown properties).
    const shapeErrors = (validate.errors ?? []).filter((e) => e.keyword !== "pattern").map(fromAjvError);
    return { valid: false, errors: [...charErrors, ...shapeErrors] };
  }
  const errors: ModelError[] = [...charErrors];
  semanticChecks(doc as MigrationModel, errors);
  return { valid: errors.length === 0, errors };
}

/** Format model errors as `path: message` lines (the maintainer's path-diff style). */
export function formatModelErrors(errors: ModelError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}
