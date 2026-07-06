// Unit tests for routing an unknown `ui:field` to the fallback field: the name is
// rewritten, the original preserved in ui:options, existing options are kept,
// nested fields are caught, and the input is not mutated.

import { describe, expect, test } from "bun:test";
import { FALLBACK_FIELD_NAME, ORIGINAL_FIELD_OPTION, remapCustomFields } from "./remapCustomFields.ts";

describe("remapCustomFields", () => {
  test("rewrites a top-level ui:field and preserves the original name", () => {
    const out = remapCustomFields({
      ovenModel: { "ui:field": "CakePickerWithDefault" },
    });
    expect(out).toEqual({
      ovenModel: {
        "ui:field": FALLBACK_FIELD_NAME,
        "ui:options": { [ORIGINAL_FIELD_OPTION]: "CakePickerWithDefault" },
      },
    });
  });

  test("keeps existing ui:options alongside the stashed original name (plugin-composed)", () => {
    const out = remapCustomFields({
      ovenModel: {
        "ui:field": "CakePickerWithDefault",
        "ui:options": { path: "bakery/oven-models", default: "deck-3000" },
      },
    });
    expect(out.ovenModel).toEqual({
      "ui:field": FALLBACK_FIELD_NAME,
      "ui:options": {
        path: "bakery/oven-models",
        default: "deck-3000",
        [ORIGINAL_FIELD_OPTION]: "CakePickerWithDefault",
      },
    });
  });

  test("leaves plain widgets untouched", () => {
    const input = { notes: { "ui:widget": "textarea" } };
    expect(remapCustomFields(input)).toEqual(input);
  });

  test("catches a nested custom field (inside items)", () => {
    const out = remapCustomFields({
      items: { sku: { "ui:field": "SkuPicker" } },
    });
    expect((out.items as any).sku["ui:field"]).toBe(FALLBACK_FIELD_NAME);
    expect((out.items as any).sku["ui:options"][ORIGINAL_FIELD_OPTION]).toBe("SkuPicker");
  });

  test("does not mutate the input", () => {
    const input = { a: { "ui:field": "X", "ui:options": { k: 1 } } };
    const snapshot = JSON.parse(JSON.stringify(input));
    remapCustomFields(input);
    expect(input).toEqual(snapshot);
  });
});
