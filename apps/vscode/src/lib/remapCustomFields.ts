// Routing an unknown `ui:field` to our fallback field.
//
// Backstage templates name CUSTOM field extensions via `ui:field` — e.g.
// `CakePickerWithDefault` in the plugin-composed example. We ship NONE of those
// extensions, so to RJSF the name is unknown: rather than error, RJSF silently
// IGNORES it and renders the field by its JSON-Schema type. That would hide the
// fact a custom field was in play. We want the opposite — a visible, labelled
// fallback input with a hint naming the extension — so we REWRITE every `ui:field`
// in the uiSchema to our one registered fallback (`FALLBACK_FIELD_NAME`),
// stashing the original name in `ui:options` so the fallback can name it.
//
// This walks the SAME uiSchema shape the splitter produces: a tree keyed by
// property name, with nested `items` and per-property objects. The input is not
// mutated — a deep copy is returned.

import type { UiSchema } from "../webview/protocol.ts";

/** The registry key our fallback field is registered under (see the webview). */
export const FALLBACK_FIELD_NAME = "tdkCustomField";
/** Where we stash the original `ui:field` name so the fallback can display it. */
export const ORIGINAL_FIELD_OPTION = "tdkOriginalField";

/** A plain object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a deep copy of `uiSchema` with every `ui:field` rewritten to the fallback
 * field, preserving the original name under `ui:options.tdkOriginalField`. Recurses
 * into every nested object (property entries, `items`, and so on) so a custom field
 * anywhere in the tree is caught.
 */
export function remapCustomFields(uiSchema: UiSchema): UiSchema {
  const out: UiSchema = {};
  for (const [key, value] of Object.entries(uiSchema)) {
    if (key === "ui:field" && typeof value === "string") {
      out["ui:field"] = FALLBACK_FIELD_NAME;
      // Merge the original name into ui:options (preserving any existing options).
      const existingOptions = isObject(uiSchema["ui:options"]) ? uiSchema["ui:options"] : {};
      out["ui:options"] = { ...existingOptions, [ORIGINAL_FIELD_OPTION]: value };
      continue;
    }
    if (key === "ui:options" && isObject(value)) {
      // If we already wrote ui:options for a remapped field above, don't clobber it.
      out["ui:options"] = isObject(out["ui:options"]) ? { ...value, ...out["ui:options"] } : { ...value };
      continue;
    }
    out[key] = isObject(value) ? remapCustomFields(value as UiSchema) : value;
  }
  return out;
}
