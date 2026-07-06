// The schema / uiSchema splitter — the most bug-prone piece of the form preview,
// so it lives in its own pure module with thorough tests.
//
// THE PROBLEM. Backstage embeds RJSF ui-hints INSIDE the JSON Schema: a property
// carries `ui:widget`, `ui:field`, `ui:options`, `ui:autofocus`, `ui:order`, and
// so on right alongside `type`/`title`. RJSF wants the opposite — a pure JSON
// Schema, plus a SEPARATE `uiSchema` object that MIRRORS the schema's shape and
// holds only the `ui:*` keys. So we walk a page's schema and split it in two.
//
// THE SHAPE we mirror (verified against compiled TDK output):
//   - `properties.<name>` — recurse; the child's uiSchema nests under `<name>`.
//   - `items` (object OR tuple array) — recurse; nests under `items`.
//   - `dependencies.<name>` — a schema dependency (an object, possibly with
//     `oneOf`/`anyOf`/`allOf` branches) OR a property dependency (a string
//     array — no schema, nothing to split). TDK's `showWhen`/`dep.when` compile
//     to `dependencies.<name>.oneOf[].properties.<revealed>`, where a
//     conditionally-revealed field can carry its OWN `ui:*`.
//   - `oneOf` / `anyOf` / `allOf` — recurse into each branch.
//
// THE MERGE RULE (the subtle part). RJSF addresses a uiSchema by PROPERTY NAME,
// not by which conditional branch revealed the property. A field that only
// appears inside a `dependencies.orderType.oneOf[2].properties.topper` branch is
// still `uiSchema.topper` to RJSF. So the `ui:*` we find deep inside `oneOf` /
// `anyOf` / `allOf` / `dependencies` branches is MERGED UP into the enclosing
// object's uiSchema by property name — never nested under `dependencies`/`oneOf`
// (RJSF ignores it there). Two branches touching the same field deep-merge; a
// later `ui:*` scalar wins on a real conflict (rare — branches are disjoint).
//
// The output schema is a deep structural COPY with every `ui:*` key stripped; the
// input is never mutated.

import type { JsonSchema, UiSchema } from "../webview/protocol.ts";

/** The result of splitting one schema node: its pure schema + mirrored uiSchema. */
export interface SplitResult {
  schema: JsonSchema;
  uiSchema: UiSchema;
}

/** A `ui:*` key is any property key that starts with the `ui:` prefix. */
function isUiKey(key: string): boolean {
  return key.startsWith("ui:");
}

/** A plain object (not null, not an array) — the only thing we recurse into. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `source` into `target` IN PLACE and return it. Objects merge
 * recursively; on any non-object (a `ui:*` scalar, array, `ui:options` we treat
 * atomically) `source` wins. Used to fold branch uiSchemas up by property name.
 */
function mergeUiSchema(target: UiSchema, source: UiSchema): UiSchema {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isObject(existing) && isObject(value)) {
      mergeUiSchema(existing, value as UiSchema);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/** Add `fragment` under `key` in `uiSchema`, but only if it carried any hints. */
function assignIfNotEmpty(uiSchema: UiSchema, key: string, fragment: UiSchema): void {
  if (Object.keys(fragment).length > 0) uiSchema[key] = fragment;
}

/**
 * Split one JSON Schema node into `{ schema, uiSchema }`. Recurses through
 * `properties`, `items`, `dependencies`, and the `oneOf`/`anyOf`/`allOf`
 * combinators. See the module header for the shape and the merge rule.
 */
export function splitUiSchema(node: JsonSchema): SplitResult {
  const schema: JsonSchema = {};
  const uiSchema: UiSchema = {};

  for (const [key, value] of Object.entries(node)) {
    // 1. A `ui:*` hint on THIS node — lift it out into the uiSchema verbatim.
    if (isUiKey(key)) {
      uiSchema[key] = value;
      continue;
    }

    // 2. `properties` — recurse into each; nest each child's uiSchema by name.
    if (key === "properties" && isObject(value)) {
      const cleanedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        if (isObject(propSchema)) {
          const child = splitUiSchema(propSchema);
          cleanedProps[propName] = child.schema;
          assignIfNotEmpty(uiSchema, propName, child.uiSchema);
        } else {
          cleanedProps[propName] = propSchema;
        }
      }
      schema.properties = cleanedProps;
      continue;
    }

    // 3. `items` — an object schema OR a tuple (array of schemas). Recurse; the
    //    uiSchema nests under `items` (RJSF's array-item uiSchema key).
    if (key === "items") {
      if (isObject(value)) {
        const child = splitUiSchema(value);
        schema.items = child.schema;
        assignIfNotEmpty(uiSchema, "items", child.uiSchema);
      } else if (Array.isArray(value)) {
        const cleaned: unknown[] = [];
        const itemsUi: UiSchema = {};
        value.forEach((entry, i) => {
          if (isObject(entry)) {
            const child = splitUiSchema(entry);
            cleaned.push(child.schema);
            if (Object.keys(child.uiSchema).length > 0) itemsUi[i] = child.uiSchema;
          } else {
            cleaned.push(entry);
          }
        });
        schema.items = cleaned;
        assignIfNotEmpty(uiSchema, "items", itemsUi);
      } else {
        schema.items = value;
      }
      continue;
    }

    // 4. `dependencies` — each value is a SCHEMA dependency (object, maybe with
    //    combinators) or a PROPERTY dependency (a string array: no schema to
    //    split). Split schema deps; MERGE the revealed fields' uiSchema UP into
    //    THIS node's uiSchema (RJSF keys them by property name, not by branch).
    if (key === "dependencies" && isObject(value)) {
      const cleanedDeps: Record<string, unknown> = {};
      for (const [depName, depValue] of Object.entries(value)) {
        if (isObject(depValue)) {
          const child = splitUiSchema(depValue);
          cleanedDeps[depName] = child.schema;
          mergeUiSchema(uiSchema, child.uiSchema);
        } else {
          cleanedDeps[depName] = depValue; // property dependency (string[]) — copy verbatim
        }
      }
      schema.dependencies = cleanedDeps;
      continue;
    }

    // 5. `oneOf` / `anyOf` / `allOf` — recurse into each branch; MERGE each
    //    branch's uiSchema UP into THIS node (branches reveal fields addressed by
    //    name, so their hints belong at the enclosing level).
    if ((key === "oneOf" || key === "anyOf" || key === "allOf") && Array.isArray(value)) {
      const cleaned: unknown[] = [];
      for (const branch of value) {
        if (isObject(branch)) {
          const child = splitUiSchema(branch);
          cleaned.push(child.schema);
          mergeUiSchema(uiSchema, child.uiSchema);
        } else {
          cleaned.push(branch);
        }
      }
      schema[key] = cleaned;
      continue;
    }

    // 6. Anything else (type, title, enum, required, const, format, …) — copy
    //    verbatim. Arrays and scalars are values, not schemas, so we never
    //    recurse into them here.
    schema[key] = value;
  }

  return { schema, uiSchema };
}
