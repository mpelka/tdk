// Reading a PLAIN YAML Backstage Scaffolder template into the SAME artifact shape
// `compile()` produces — `{ object, yaml }` — so everything downstream (validate,
// the dry-run/task client) accepts a hand-authored YAML template exactly as it
// accepts a compiled TDK one.
//
// This grew out of the VS Code extension's `detectYamlTemplate` (the form preview's
// plain-YAML path): the pipeline is source-agnostic after "compiled YAML" — parse the
// YAML, take `spec.parameters` → the form. A teammate who authors templates as plain
// YAML (not TDK TypeScript) gets the same preview, and now the same scriptable
// dry-run, because `fromYaml` hands back an artifact interchangeable with `compile`'s.
//
// It is a PURE gatekeeper, testable without any runtime. It answers one question about
// a document's text: is this a Scaffolder template we can use? A document qualifies
// only when it is a SINGLE YAML document whose top level is a map with:
//   - `apiVersion` starting with `scaffolder.backstage.io/` (e.g. `.../v1beta3`), and
//   - `kind: Template`.
// Everything else — a k8s manifest (`apiVersion: v1`, `kind: ConfigMap`), a template
// missing its `kind`, a non-map root, empty/blank text — is `notTemplate`, carrying a
// `reason` the caller can surface.
//
// MULTI-DOCUMENT files are deliberately rejected: `spec.parameters` has one meaning per
// document, and a downstream single-document `parse()` THROWS on a multi-document
// source anyway. Rejecting here keeps that a clean `notTemplate`, not a crash.
//
// A file that IS a template but fails to PARSE (a YAML syntax error) is reported as a
// `parseError` WITH a `file:line` location when the `yaml` library gives one — the same
// shape a compile-error banner already renders for the TS path.

import { parseAllDocuments } from "yaml";
import type { TemplateEntity } from "./compile.ts";

/** The `apiVersion` prefix every Scaffolder template carries. */
const SCAFFOLDER_API_PREFIX = "scaffolder.backstage.io/";

/** The `kind` a Scaffolder template declares. */
const TEMPLATE_KIND = "Template";

/**
 * The outcome of reading a document's text as a possible plain-YAML template:
 *   - `template` — it IS a single-document Scaffolder template. Carries `object` (the
 *     parsed entity) and `yaml` (the original text), the SAME `{ object, yaml }` shape
 *     `compile()` returns, so it flows straight into `validate`, `dryRun`, `createTask`.
 *   - `parseError` — it LOOKS like YAML we should parse but has a syntax error; carries
 *     the message and, when the library located it, a 1-based `line`.
 *   - `notTemplate` — it is valid YAML (or empty) but not a Scaffolder template (a k8s
 *     manifest, a missing `kind`, a multi-doc file, a non-map root); carries a `reason`.
 */
export type FromYamlResult =
  | { kind: "template"; object: TemplateEntity; yaml: string }
  | { kind: "parseError"; message: string; line?: number }
  | { kind: "notTemplate"; reason: string };

/** A plain object (not null, not an array) — the only root shape a template can have. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed root object is a Scaffolder template: `apiVersion` starts with
 * `scaffolder.backstage.io/` AND `kind` is exactly `Template`. Both must be strings;
 * a missing or non-string either one fails.
 */
function isScaffolderTemplate(root: Record<string, unknown>): boolean {
  const apiVersion = root.apiVersion;
  const kind = root.kind;
  return typeof apiVersion === "string" && apiVersion.startsWith(SCAFFOLDER_API_PREFIX) && kind === TEMPLATE_KIND;
}

/** The `reason` string a `notTemplate` result carries — one per rejection cause. */
const NOT_A_TEMPLATE = "not a Scaffolder template (needs apiVersion scaffolder.backstage.io/… and kind: Template)";

/**
 * Read a document's text as a candidate plain-YAML Scaffolder template. Returns a
 * `template` (with its `{ object, yaml }` artifact), a `parseError` (a genuine template
 * we failed to parse, with a `line` when located), or `notTemplate` (anything else,
 * with a `reason`).
 *
 * CRLF is handled by the `yaml` parser natively (it normalizes line endings), so a
 * CRLF-authored template is read the same as an LF one. A multi-document file is
 * `notTemplate` — one `spec.parameters` per document is required, and a downstream
 * `parse()` throws on multiple documents regardless.
 *
 * The parse-error branch only fires when the SOLE document plausibly meant to be this
 * template failed to parse; a syntax error in a file that is clearly not a template is
 * still `notTemplate`, so we never hijack an unrelated broken YAML.
 */
export function fromYaml(text: string): FromYamlResult {
  // Blank / whitespace-only text is not a template.
  if (text.trim() === "") return { kind: "notTemplate", reason: "empty document" };

  // `parseAllDocuments` never throws on a syntax error — it collects them per document,
  // and it lets us see the document COUNT so we can reject a multi-doc file cleanly.
  const documents = parseAllDocuments(text);

  // Zero documents (only comments / directives) — not a template.
  if (documents.length === 0) return { kind: "notTemplate", reason: "no YAML document found" };
  // More than one document: one `spec.parameters` per doc is required, and a downstream
  // single-document `parse()` would throw — reject before that.
  if (documents.length > 1) return { kind: "notTemplate", reason: "multiple YAML documents" };

  const doc = documents[0]!;

  // A syntax error: decide whether this document was MEANT to be a template. We can
  // only read the parsed contents when it parsed enough to yield a JS value; when it
  // didn't, we can't know it was a template, so treat it as a fallback (notTemplate).
  if (doc.errors.length > 0) {
    let root: unknown;
    try {
      root = doc.toJS();
    } catch {
      root = undefined;
    }
    if (isRecord(root) && isScaffolderTemplate(root)) {
      const first = doc.errors[0]!;
      const line = first.linePos?.[0]?.line;
      return { kind: "parseError", message: first.message, line };
    }
    return { kind: "notTemplate", reason: NOT_A_TEMPLATE };
  }

  const root = doc.toJS();
  if (!isRecord(root)) return { kind: "notTemplate", reason: "the document root is not a mapping" };
  if (!isScaffolderTemplate(root)) return { kind: "notTemplate", reason: NOT_A_TEMPLATE };

  // The parsed entity IS the artifact object, and the caller's OWN text IS the `yaml` —
  // a YAML source is its own truest artifact, so we carry it verbatim (comments, key
  // order, and all) rather than a lossy re-serialization. `object`/`yaml` mirror
  // `compile()`'s `{ object, yaml }` shape, so a plain-YAML template flows into
  // `validate`/`dryRun`/`createTask` exactly like a compiled one.
  return {
    kind: "template",
    // The gate proved apiVersion + kind; the rest of the entity is the author's own
    // YAML, so the strict `TemplateEntity` shape is a convenience for readers, not a
    // guarantee — hence the double cast through `unknown`.
    object: root as unknown as TemplateEntity,
    yaml: text,
  };
}
