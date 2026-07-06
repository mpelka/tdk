// Pairing a step's SOURCE expression (from the compiled YAML, pre-render) with its
// RESOLVED value (from the execute() trace) — the data behind the trace view's
// "Inputs with provenance" section.
//
// The extension has both halves. `spec.steps[].input` in the compiled YAML still
// holds the `${{ … }}` template strings (compile emits them verbatim — it does NOT
// render them). The trace's `steps[id].input` holds the values those templates
// resolved to for the current form. This module pairs them by step id and key path,
// walking nested objects/arrays recursively so a deep input (a `data` object, an
// array of items) pairs leaf-by-leaf.
//
// A leaf is TEMPLATED when its source string carries a `${{ … }}` marker and its
// resolved value DIFFERS from the source — then the UI shows `expression → value`.
// It is LITERAL when the source has no marker OR the two sides are identical (a
// plain literal the author wrote, which compile passed through unchanged) — then
// the UI shows just the value, no arrow.
//
// PURE and dependency-free: it takes two plain values and returns a plain tree, so
// it is unit-tested in isolation and imported by both the extension (to build the
// message) and — via the protocol type — the webview (to render it).

/** A `${{ … }}` template marker anywhere in a string means the leaf is templated. */
const TEMPLATE_MARKER = /\$\{\{[\s\S]*?\}\}/;

/**
 * One paired input node. A LEAF carries the source `expression` (the pre-render
 * string, when the step's compiled YAML had one at this path), the `value` it
 * resolved to, and whether it is `templated` (show the arrow) or a literal (show
 * the value alone). A BRANCH (object or array) carries `children` — the same node
 * recursively, one per key/index — and no value of its own.
 */
export interface ProvenanceNode {
  /** The key (object property) or index (array element) this node sits under, "" at the root. */
  key: string;
  kind: "leaf" | "object" | "array";
  /** LEAF only: the source expression string from the compiled YAML (undefined when absent). */
  expression?: string;
  /** LEAF only: the resolved value from the trace. */
  value?: unknown;
  /** LEAF only: true when the source is a `${{ … }}` template AND differs from the value. */
  templated?: boolean;
  /** BRANCH only: the child nodes, in key/index order. */
  children?: ProvenanceNode[];
}

/** Whether a value is a plain object (not null, not an array) — a provenance BRANCH. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A leaf is TEMPLATED when its SOURCE is a string carrying a `${{ … }}` marker and
 * there is a RESOLVED value that is not identical to that source. A source with a
 * marker whose value equals the source verbatim (the render was a no-op), or a step
 * that never resolved a value (undefined — it errored first), reads as a literal:
 * there is nothing to show an arrow toward.
 */
function isTemplated(source: unknown, value: unknown): boolean {
  if (typeof source !== "string" || !TEMPLATE_MARKER.test(source)) return false;
  if (value === undefined) return false;
  return source !== value;
}

/**
 * Pair one source value with one resolved value into a `ProvenanceNode` tree,
 * recursing through objects and arrays. `key` labels this node under its parent.
 *
 * The SHAPE spans the UNION of both sides so a key present only in the source (never
 * resolved) or only in the resolved value still shows. At a LEAF, the source (if a
 * string) is the expression and the value is the resolved side; `templated` gates
 * the arrow.
 */
export function pairValue(key: string, source: unknown, value: unknown): ProvenanceNode {
  // An OBJECT on either side → a branch keyed by the union of both sides' keys.
  // A TEMPLATED SOURCE is ALWAYS a leaf, whatever shape it resolved to — a
  // `${{ parameters.tags }}` resolving to an array/object must keep its expression;
  // letting the branch cases below win would recurse on the value alone and
  // silently drop the source expression.
  if (typeof source === "string" && TEMPLATE_MARKER.test(source)) {
    const node: ProvenanceNode = { key, kind: "leaf", value, expression: source };
    if (isTemplated(source, value)) node.templated = true;
    return node;
  }

  // Branching is VALUE-driven: the trace's resolved value is the truth of what the
  // step received; the source side shapes the branch only when the value is absent
  // (a step that errored before resolving), so authored keys still show. A source
  // branch paired with a resolved SCALAR therefore falls through to the leaf below —
  // the scalar must never be dropped in favor of the source's shape.
  if (isPlainObject(value) || (value === undefined && isPlainObject(source))) {
    const src = isPlainObject(source) ? source : {};
    const val = isPlainObject(value) ? value : {};
    const keys = unionKeys(Object.keys(src), Object.keys(val));
    return { key, kind: "object", children: keys.map((k) => pairValue(k, src[k], val[k])) };
  }

  // An ARRAY value (or an array source with no value) → a branch keyed by index,
  // spanning the longer length so a length mismatch never silently drops elements.
  if (Array.isArray(value) || (value === undefined && Array.isArray(source))) {
    const src = Array.isArray(source) ? source : [];
    const val = Array.isArray(value) ? value : [];
    const length = Math.max(src.length, val.length);
    const children: ProvenanceNode[] = [];
    for (let i = 0; i < length; i++) children.push(pairValue(String(i), src[i], val[i]));
    return { key, kind: "array", children };
  }

  // A scalar (or a missing side) → a leaf. The source, if a string, is the
  // expression; the value is the resolved side. The arrow shows only when templated.
  const node: ProvenanceNode = { key, kind: "leaf", value };
  if (typeof source === "string") node.expression = source;
  if (isTemplated(source, value)) node.templated = true;
  return node;
}

/** The union of two key lists, source order first, preserving first-seen order. */
function unionKeys(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const k of b) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Pair a whole step's compiled `input` (the `${{ … }}` source object from
 * `spec.steps[].input`) with its resolved `input` (from the trace) into the
 * top-level provenance rows the detail view renders — one per input KEY.
 *
 * A step whose compiled input is missing (an action with no `input:`, or a step id
 * the YAML never named) pairs against `{}` on that side, so the resolved values
 * still render as bare literals. Order follows the source keys first (author order),
 * then any resolved-only keys.
 */
export function pairStepInputs(sourceInput: unknown, resolvedInput: unknown): ProvenanceNode[] {
  const src = isPlainObject(sourceInput) ? sourceInput : {};
  const val = isPlainObject(resolvedInput) ? resolvedInput : {};
  const keys = unionKeys(Object.keys(src), Object.keys(val));
  return keys.map((k) => pairValue(k, src[k], val[k]));
}
