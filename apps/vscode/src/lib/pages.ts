// Normalizing `spec.parameters` into a list of form pages.
//
// Backstage's `spec.parameters` is EITHER a single page object (one `{ title?,
// properties, required?, ... }`) OR an array of such page objects — TDK emits the
// single-object form for a one-page template (`fallback-chains`,
// `payload-assembly`) and the array form for a multi-page wizard
// (`conditional-forms`, `env-loaded`). The webview always wants a list, so we
// normalize to one here, then split each page for RJSF.

import type { FormPage, JsonSchema } from "../webview/protocol.ts";
import { splitUiSchema } from "./uiSchema.ts";

/** A plain object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize `spec.parameters` to an array of raw page schemas. Accepts the single
 * page object, the array-of-pages form, or nothing (an empty/absent
 * `parameters`), always returning an array — never throwing on a shape it doesn't
 * recognise (a non-object entry is dropped).
 */
export function normalizePages(parameters: unknown): JsonSchema[] {
  if (parameters === undefined || parameters === null) return [];
  const list = Array.isArray(parameters) ? parameters : [parameters];
  return list.filter(isObject) as JsonSchema[];
}

/**
 * Normalize `spec.parameters` AND split each page for RJSF in one step: returns
 * the `FormPage[]` the webview renders — each with its pure `schema`, mirrored
 * `uiSchema`, and its `title` (the stepper step label) lifted out of the page.
 */
export function toFormPages(parameters: unknown): FormPage[] {
  return normalizePages(parameters).map((page) => {
    const { title, ...rest } = page;
    const { schema, uiSchema } = splitUiSchema(rest);
    return { title: typeof title === "string" ? title : undefined, schema, uiSchema };
  });
}
