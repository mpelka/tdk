// Validity gating for the LOCAL simulate — the pure seam that decides whether the
// current form values are complete enough to bother running `execute()`.
//
// WHY. Every form edit used to trigger a local `execute()`, so an EMPTY form produced a
// garbage trace: a jsonata step erroring on a missing `${{ parameters.x }}`, then a
// cascade of downstream noise. That is not a useful debugger surface. So before running,
// the webview checks the values against the page schemas' required fields; only a complete
// form runs. An incomplete one shows a quiet placeholder (or keeps the last valid trace
// under a banner) instead.
//
// WHAT "REQUIRED" MEANS. `spec.parameters` is a LIST of page schemas, and each page has
// its OWN `required` array (the wizard validates page by page) — plus CONDITIONAL
// requireds: TDK compiles `showWhen` / `dep.when` into `dependencies.<controller>.oneOf[]`
// branches, each `{ properties: { <controller>: <match>, …revealed }, required?, and
// possibly nested dependencies }` (see core's pages.ts). A required field revealed in the
// ACTIVE branch gates RJSF's Next exactly like a top-level one, so this check walks the
// dependency tree too: for each controller, find the branch whose match fragment
// (`const` / `enum` / `not`+`const`) the CURRENT value satisfies, merge that branch's
// `required`, and recurse into its nested dependencies. The plain JSON-Schema property/
// schema dependency forms (`dependencies.<key>: [names]` / `{ required }` — reachable via
// `rawDependencies`) activate when `<key>` is present.
//
// DIRECTION GUARANTEE — never a false POSITIVE. An inactive branch's required must never
// be reported missing, so a branch is merged only on a POSITIVE match: the controller's
// value is present and satisfies a fragment we recognize. An unset controller, an
// unrecognized match fragment, or any shape we can't evaluate (e.g. a `rawSchema` if/then)
// merges nothing — the gate may under-report (RJSF still blocks at Next), but it never
// blocks a simulate RJSF would allow.
//
// WHAT WE REPORT. `valid` (all required present) and, when not, `missing` — the missing
// fields BY THEIR SCHEMA `title` (what the user sees on the field; a revealed field's
// title lives on its BRANCH properties), falling back to the property name. Ordered by
// page, then declaration order, deduped.
//
// "Present" = the key exists and is not `undefined`/`null`/`""`/`[]` — the same empties
// RJSF's own required check rejects, so this agrees with the form's Next-button gating.
//
// PURE + dependency-free (no ajv, no `vscode`): two plain inputs → a plain result, so it
// is unit-tested in isolation and imported by the webview (App.tsx) to gate + to report.

import type { FormPage, JsonSchema } from "../webview/protocol.ts";

/** The gating verdict: whether the form is complete, and which required fields are missing. */
export interface FormValidity {
  /** True when every ACTIVE required property is present (non-empty) in the values. */
  valid: boolean;
  /** The missing required fields, by schema `title` (fallback: property name), in form order. */
  missing: string[];
}

/** A plain object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a value counts as PRESENT for a required check — the same empties RJSF rejects:
 * `undefined`, `null`, an empty string, and an empty array all read as absent, so a
 * touched-but-empty field still gates. Any other value (including `0`, `false`, `{}`) is
 * present.
 */
function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The human label for a missing property: its schema `title`, searched through the
 * `properties` scopes INNERMOST-first (a revealed field's title lives on the branch that
 * revealed it, not on the page), else the property name.
 */
function fieldLabel(scopes: Record<string, unknown>[], property: string): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const propSchema = scopes[i]?.[property];
    if (isObject(propSchema) && typeof propSchema.title === "string" && propSchema.title.length > 0) {
      return propSchema.title;
    }
  }
  return property;
}

/**
 * Whether a dependency branch POSITIVELY matches the controller's current value. The
 * match fragment rides on `branch.properties.<controller>` and is one of the three forms
 * core compiles (`{ const }`, `{ enum }`, `{ not: { const } }`). An unset controller or an
 * unrecognized fragment NEVER matches — the no-false-positive guarantee.
 */
function branchMatches(branch: Record<string, unknown>, controller: string, value: unknown): boolean {
  if (value === undefined) return false;
  const props = isObject(branch.properties) ? branch.properties : undefined;
  const frag = props && isObject(props[controller]) ? props[controller] : undefined;
  if (!frag) return false;
  if ("const" in frag) return value === frag.const;
  if (Array.isArray(frag.enum)) return frag.enum.includes(value);
  const not = frag.not;
  if (isObject(not) && "const" in not) return value !== not.const;
  return false; // a fragment we don't recognize — never guess a match
}

/** A missing-field sink that dedupes by label while preserving first-seen order. */
type AddMissing = (label: string) => void;

/**
 * Collect the missing required fields of one schema NODE (a page, or an active dependency
 * branch): its own `required` list, then its `dependencies` — recursing into the branch
 * each controller's current value positively activates. `scopes` is the stack of
 * `properties` objects for title lookup (page first, then each active branch).
 */
function collectMissing(
  node: JsonSchema,
  values: Record<string, unknown>,
  scopes: Record<string, unknown>[],
  add: AddMissing,
): void {
  // 1. The node's own required list.
  const required = Array.isArray(node.required) ? (node.required as unknown[]) : [];
  for (const prop of required) {
    if (typeof prop !== "string") continue;
    if (!isPresent(values[prop])) add(fieldLabel(scopes, prop));
  }

  // 2. The node's dependencies — the conditional requireds.
  const dependencies = isObject(node.dependencies) ? node.dependencies : undefined;
  if (!dependencies) return;
  for (const [controller, dep] of Object.entries(dependencies)) {
    // The plain PROPERTY-dependency form (`<key>: ["a","b"]`): active when the key is
    // present — the listed names become required.
    if (Array.isArray(dep)) {
      if (!isPresent(values[controller])) continue;
      for (const prop of dep) {
        if (typeof prop === "string" && !isPresent(values[prop])) add(fieldLabel(scopes, prop));
      }
      continue;
    }
    if (!isObject(dep)) continue;
    // The `oneOf` branch form (what core compiles showWhen / dep.when to): recurse into
    // the FIRST branch the controller's value positively matches — mirroring RJSF, which
    // resolves a oneOf dependency to the first branch the form data validates against.
    if (Array.isArray(dep.oneOf)) {
      for (const rawBranch of dep.oneOf) {
        if (!isObject(rawBranch)) continue;
        if (!branchMatches(rawBranch, controller, values[controller])) continue;
        const branchProps = isObject(rawBranch.properties) ? rawBranch.properties : {};
        collectMissing(rawBranch as JsonSchema, values, [...scopes, branchProps], add);
        break;
      }
      continue;
    }
    // The SCHEMA-dependency form without oneOf (`{ required: [...] }`, via
    // rawDependencies): active when the key is present.
    if (Array.isArray(dep.required) && isPresent(values[controller])) {
      for (const prop of dep.required) {
        if (typeof prop === "string" && !isPresent(values[prop])) add(fieldLabel(scopes, prop));
      }
    }
  }
}

/**
 * Compute whether the form values satisfy every page's required fields — top-level AND the
 * active dependency branches' — and list the missing ones by their display title. `values`
 * is the merged cross-page form data (the webview keeps one object across pages). A field
 * required by two pages is reported once (deduped by label).
 */
export function formValidity(pages: FormPage[], values: Record<string, unknown>): FormValidity {
  const missing: string[] = [];
  const seen = new Set<string>();
  const add: AddMissing = (label) => {
    if (seen.has(label)) return;
    seen.add(label);
    missing.push(label);
  };
  for (const page of pages) {
    const pageProps = isObject(page.schema.properties) ? page.schema.properties : {};
    collectMissing(page.schema, values, [pageProps], add);
  }
  return { valid: missing.length === 0, missing };
}
