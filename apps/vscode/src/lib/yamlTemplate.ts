// Detecting — and reading — a PLAIN YAML Backstage Scaffolder template.
//
// The form preview's pipeline is source-agnostic after "compiled YAML": parse the
// YAML, take `spec.parameters` → `toFormPages` → the form. So a teammate who authors
// templates as plain YAML (not TDK TypeScript) can get the same form preview — we just
// SKIP the `tdk compile` step and treat the editor buffer itself as the artifact.
//
// This module is the PURE gatekeeper for that path, unit-tested without `vscode`. It
// answers one question about a document's text: is this a Scaffolder template we can
// preview? A document qualifies only when it is a SINGLE YAML document whose top level
// is a map with:
//   - `apiVersion` starting with `scaffolder.backstage.io/` (e.g. `.../v1beta3`), and
//   - `kind: Template`.
// Everything else — a k8s manifest (`apiVersion: v1`, `kind: ConfigMap`), a template
// missing its `kind`, a non-map root, empty/blank text — is NOT a template here, so the
// preview command falls back to its usual "open a .ts template" behaviour.
//
// MULTI-DOCUMENT files are deliberately rejected: `spec.parameters` has one meaning per
// document, and the downstream `yaml` `parse()` (which both the form parse and the
// dry-run use) THROWS on a multi-document source anyway. Rejecting here keeps that a
// clean "not a template", not a crash.
//
// A file that IS a template but fails to PARSE (a YAML syntax error) is reported as a
// parse error WITH a `file:line` location when the `yaml` library gives one — the same
// shape the compile-error banner already renders for the TS path.

import { parseAllDocuments } from "yaml";

/** The `apiVersion` prefix every Scaffolder template carries. */
const SCAFFOLDER_API_PREFIX = "scaffolder.backstage.io/";

/** The `kind` a Scaffolder template declares. */
const TEMPLATE_KIND = "Template";

/**
 * The outcome of inspecting a document's text as a possible plain-YAML template:
 *   - `template` — it IS a single-document Scaffolder template; carries the parsed
 *     `parameters`/`steps` (for the form + trace-provenance narrowing) and its
 *     display `title`/`name` (for the panel header).
 *   - `parseError` — it LOOKS like YAML we should parse but has a syntax error;
 *     carries the message and, when the library located it, a 1-based `line`.
 *   - `notTemplate` — it is valid YAML (or empty) but not a Scaffolder template
 *     (a k8s manifest, a missing `kind`, a multi-doc file, a non-map root): the
 *     preview command should fall back to its `.ts` behaviour.
 */
export type YamlTemplateResult =
  | {
      kind: "template";
      parameters: unknown;
      steps: unknown;
      title?: string;
      name?: string;
    }
  | { kind: "parseError"; message: string; line?: number }
  | { kind: "notTemplate" };

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

/**
 * Inspect a document's text as a candidate plain-YAML Scaffolder template. Returns a
 * `template` (with its `parameters`/`steps`/`title`/`name`), a `parseError` (a genuine
 * template we failed to parse, with a `line` when located), or `notTemplate` (anything
 * else — the caller falls back to the `.ts` path).
 *
 * CRLF is handled by the `yaml` parser natively (it normalizes line endings), so a
 * CRLF-authored template is detected the same as an LF one. A multi-document file is
 * `notTemplate` — one `spec.parameters` per document is required, and the downstream
 * `parse()` throws on multiple documents regardless.
 *
 * The parse-error branch only fires when the SOLE document plausibly meant to be this
 * template failed to parse; a syntax error in a file that is clearly not a template is
 * still `notTemplate`, so we never hijack the fallback for an unrelated broken YAML.
 */
export function detectYamlTemplate(text: string): YamlTemplateResult {
  // Blank / whitespace-only text is not a template — let the `.ts` fallback speak.
  if (text.trim() === "") return { kind: "notTemplate" };

  // `parseAllDocuments` never throws on a syntax error — it collects them per document,
  // and it lets us see the document COUNT so we can reject a multi-doc file cleanly.
  const documents = parseAllDocuments(text);

  // Zero documents (only comments / directives) — not a template.
  if (documents.length === 0) return { kind: "notTemplate" };
  // More than one document: one `spec.parameters` per doc is required, and the
  // downstream single-document `parse()` would throw — reject before that.
  if (documents.length > 1) return { kind: "notTemplate" };

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
    return { kind: "notTemplate" };
  }

  const root = doc.toJS();
  if (!isRecord(root) || !isScaffolderTemplate(root)) return { kind: "notTemplate" };

  const spec = isRecord(root.spec) ? root.spec : undefined;
  const metadata = isRecord(root.metadata) ? root.metadata : undefined;
  const title = typeof metadata?.title === "string" ? metadata.title : undefined;
  const name = typeof metadata?.name === "string" ? metadata.name : undefined;

  return {
    kind: "template",
    parameters: spec?.parameters,
    steps: spec?.steps,
    title,
    name,
  };
}
