// Humanizing RJSF/ajv validation messages for the form (issue #3, phase 2 polish).
//
// ajv (through RJSF's ajv8 validator) phrases its errors for a schema author, not a
// form user: `must have required property 'contactEmail'`, `must be equal to one of
// the allowed values`. RJSF also PREFIXES the field label onto each message, so the
// raw text reads doubly awkward. Backstage rewrites these before showing them; so do
// we — a pure transform over the RJSF error list.
//
// The rules, in order:
//   - `must have required property 'X'`  → `X is required`
//   - a schema-authored `errorMessage` (via ajv-errors) is left verbatim — the
//     author already wrote it for the user (ajv-errors emits keyword `errorMessage`).
//   - every other message keeps its wording but sheds ajv's `must …` prefix noise
//     only where it reads better; unknown messages pass through unchanged.
//
// PURE and framework-free at its core: `humanizeMessage` takes a raw string and the
// property name and returns the friendly text, so it is unit-tested in isolation.
// `transformErrors` is the thin RJSF adapter that maps it over the error list.

import type { RJSFValidationError } from "@rjsf/utils";

/** `must have required property 'contactEmail'` → capture the property name. */
const REQUIRED_RE = /must have required property ['"]([^'"]+)['"]/;

/**
 * Humanize ONE ajv message for a form user. `property` is the RJSF error's dotted
 * property path (e.g. `.contactEmail`), used to name the field in a rewritten
 * "required" message. Returns the friendly string; an unrecognized message is
 * returned unchanged (never dropped — a wrong-but-honest message beats a hidden one).
 */
export function humanizeMessage(message: string | undefined, property: string | undefined): string {
  const raw = (message ?? "").trim();

  // `must have required property 'X'` → `X is required`. Prefer the name ajv quoted
  // (the actual missing property) over the RJSF `property` path, which on a required
  // error points at the PARENT object, not the missing child.
  const required = raw.match(REQUIRED_RE);
  if (required) {
    const name = required[1] ?? leafName(property) ?? "This field";
    return `${humanizeName(name)} is required`;
  }

  return raw;
}

/** The leaf of a dotted RJSF property path (`.data.customerName` → `customerName`). */
function leafName(property: string | undefined): string | undefined {
  if (!property) return undefined;
  const parts = property.split(".").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
}

/** A property key as a sentence-start label: first letter upper, rest verbatim. */
function humanizeName(name: string): string {
  return name.length ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * The RJSF `transformErrors` hook: map `humanizeMessage` over every error, rewriting
 * its `message` (and its `stack`, which RJSF derives from `property` + `message` and
 * some consumers read). A schema-authored `errorMessage` arrives from ajv-errors as
 * an error whose `name` is `errorMessage` — we leave those verbatim, since the author
 * already phrased them for the user.
 */
export function transformErrors(errors: RJSFValidationError[]): RJSFValidationError[] {
  return errors.map((error) => {
    // ajv-errors surfaces a schema's own `errorMessage` under this keyword — trust it.
    if (error.name === "errorMessage") return error;
    const message = humanizeMessage(error.message, error.property);
    if (message === error.message) return error;
    const property = error.property ?? "";
    return { ...error, message, stack: `${property} ${message}`.trim() };
  });
}
