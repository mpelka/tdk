// NAMING — how a model name becomes an emitted identifier.
//
// The derivation rule (documented once, applied everywhere):
//
//   1. Split the source name on every run of non-alphanumeric characters
//      (`-`, `_`, spaces, `.`, …) into tokens.
//   2. The FIRST token keeps its characters but lower-cases its first letter
//      (`BakeryCode` → `bakeryCode`, `bakery_code` → `bakery` + `Code`).
//   3. Each SUBSEQUENT token upper-cases its first letter and keeps the rest
//      (`job-summary` → `job` + `Summary` → `jobSummary`).
//   4. If the result is empty, use `field`. If it starts with a digit, prefix `_`.
//   5. If the candidate collides with a reserved identifier (a core import, a JS
//      keyword, an org-supplied helper/marker) or a const already assigned, append
//      the smallest integer ≥ 2 that makes it unique (`bakeryCode` → `bakeryCode2`).
//
// The STEP id keeps the model name VERBATIM: `derive("job-summary", …)`,
// `effect("submit-request", …)` — the kebab name is what Backstage shows in the run
// log. Only the CONST that holds the handle is camel-cased.

import type { Effect, LogicNode, Lookup, MigrationModel, Question } from "./model.ts";

/** JavaScript reserved words the emitted source must never shadow. */
const JS_KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "async",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

/** The `@tdk/core` identifiers the printer may import — a const must not shadow one. */
export const CORE_IMPORTS = [
  "defineTemplate",
  "derive",
  "effect",
  "rawEffect",
  "p",
  "page",
  "fragment",
  "all",
  "any",
  "env",
  "raw",
  "nj",
  "jsonata",
] as const;

/** Derive a camelCase const name from a source name (rule steps 1–4, no collision check). */
export function toConstName(source: string): string {
  const tokens = source.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return "field";
  const first = tokens[0];
  let name = first.charAt(0).toLowerCase() + first.slice(1);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    name += t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name;
}

/** Uniquify `candidate` against `used`, appending 2, 3, … as needed. */
function uniquify(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) return candidate;
  let n = 2;
  while (used.has(`${candidate}${n}`)) n++;
  return `${candidate}${n}`;
}

/** What kind of node a name resolves to (for `{ref}` resolution + diagnostics). */
export type NodeKind = "question" | "logic" | "lookup" | "effect";

/** One assigned const, with the node kind it belongs to and whether it is conditional. */
export interface Assigned {
  /** The emitted const identifier. */
  const: string;
  /** The node kind. */
  kind: NodeKind;
  /** For a question: whether it carries a `visibleWhen` (so it is `T | undefined`). */
  conditional: boolean;
}

/**
 * The resolved name map for a model: a const per node, and a by-name index for
 * resolving a `{ref}` across kinds. Assignment order is fixed (questions, logic,
 * lookups, effects, each in array order) so the output is deterministic.
 */
export interface NameMap {
  /** Const for a question name. */
  question: Map<string, string>;
  /** Const for a logic-node name. */
  logic: Map<string, string>;
  /** Const for a lookup name. */
  lookup: Map<string, string>;
  /** Const for an effect name. */
  effect: Map<string, string>;
  /** Every name → the node(s) that carry it (a collision has length > 1). */
  byName: Map<string, Assigned[]>;
}

/** Whether a logic node is a named IR expression (not the escape hatch). */
function logicNodeName(node: LogicNode): string {
  return node.name;
}

/**
 * Build the const map for a model. `reserved` adds org-supplied helper/marker names
 * (and anything else the emitted module imports) so a question const never shadows
 * an import.
 */
export function buildNameMap(model: MigrationModel, reserved: Iterable<string> = []): NameMap {
  const used = new Set<string>([...JS_KEYWORDS, ...CORE_IMPORTS, ...reserved]);
  const map: NameMap = {
    question: new Map(),
    logic: new Map(),
    lookup: new Map(),
    effect: new Map(),
    byName: new Map(),
  };

  const record = (name: string, kind: NodeKind, conditional: boolean): string => {
    const id = uniquify(toConstName(name), used);
    used.add(id);
    const list = map.byName.get(name) ?? [];
    list.push({ const: id, kind, conditional });
    map.byName.set(name, list);
    return id;
  };

  for (const q of model.questions ?? ([] as Question[])) {
    map.question.set(q.name, record(q.name, "question", q.visibleWhen !== undefined));
  }
  for (const node of model.logic ?? ([] as LogicNode[])) {
    const name = logicNodeName(node);
    map.logic.set(name, record(name, "logic", false));
  }
  for (const l of model.lookups ?? ([] as Lookup[])) {
    map.lookup.set(l.name, record(l.name, "lookup", false));
  }
  for (const e of model.effects ?? ([] as Effect[])) {
    map.effect.set(e.name, record(e.name, "effect", false));
  }

  return map;
}
