// Unit tests for the schema / uiSchema splitter — the bug-prone core of the form
// preview. The cases cover: a flat `ui:*` lift, nested `properties`, array
// `items` (object + tuple), the conditional `dependencies.oneOf` shape TDK emits
// for `showWhen`/`dep.when` (with `ui:*` on a REVEALED field, merged up by name),
// nested dependencies, `anyOf`/`allOf`, and immutability of the input.

import { describe, expect, test } from "bun:test";
import { splitUiSchema } from "./uiSchema.ts";

describe("splitUiSchema — leaf hints", () => {
  test("lifts a `ui:*` key on a leaf out of the schema", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "string",
      title: "Notes",
      "ui:widget": "textarea",
    });
    expect(schema).toEqual({ type: "string", title: "Notes" });
    expect(uiSchema).toEqual({ "ui:widget": "textarea" });
  });

  test("lifts every `ui:*` variant, keeping their values verbatim", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "string",
      "ui:field": "CakePicker",
      "ui:widget": "textarea",
      "ui:placeholder": "type here",
      "ui:autofocus": true,
      "ui:order": ["a", "b"],
      "ui:options": { path: "bakery/oven-models", default: "deck-3000" },
    });
    expect(schema).toEqual({ type: "string" });
    expect(uiSchema).toEqual({
      "ui:field": "CakePicker",
      "ui:widget": "textarea",
      "ui:placeholder": "type here",
      "ui:autofocus": true,
      "ui:order": ["a", "b"],
      "ui:options": { path: "bakery/oven-models", default: "deck-3000" },
    });
  });

  test("a node with no hints yields an empty uiSchema", () => {
    const { schema, uiSchema } = splitUiSchema({ type: "string", title: "Name" });
    expect(schema).toEqual({ type: "string", title: "Name" });
    expect(uiSchema).toEqual({});
  });
});

describe("splitUiSchema — properties", () => {
  test("nests a property's uiSchema under its name and omits hintless props", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "object",
      properties: {
        ovenModel: { type: "string", title: "Oven", "ui:field": "CakePicker" },
        capacity: { type: "number", title: "Capacity" },
      },
      required: ["ovenModel"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        ovenModel: { type: "string", title: "Oven" },
        capacity: { type: "number", title: "Capacity" },
      },
      required: ["ovenModel"],
    });
    // capacity had no hints, so it must NOT appear in the uiSchema.
    expect(uiSchema).toEqual({ ovenModel: { "ui:field": "CakePicker" } });
  });
});

describe("splitUiSchema — array items", () => {
  test("recurses into an object `items` schema (nested properties)", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "array",
      title: "Line items",
      items: {
        type: "object",
        properties: {
          sku: { type: "string", "ui:placeholder": "SKU-000" },
          qty: { type: "number" },
        },
      },
    });
    expect(schema.items).toEqual({
      type: "object",
      properties: { sku: { type: "string" }, qty: { type: "number" } },
    });
    expect(uiSchema).toEqual({ items: { sku: { "ui:placeholder": "SKU-000" } } });
  });

  test("recurses into a tuple `items` array, keying by index", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "array",
      items: [{ type: "string", "ui:widget": "textarea" }, { type: "number" }],
    });
    expect(schema.items).toEqual([{ type: "string" }, { type: "number" }]);
    expect(uiSchema).toEqual({ items: { 0: { "ui:widget": "textarea" } } });
  });
});

describe("splitUiSchema — conditional dependencies (TDK showWhen/dep.when)", () => {
  // The exact shape TDK compiles a `showWhen` page to: dependencies.<field>.oneOf,
  // each branch either a `const` match or a match PLUS revealed fields carrying
  // their own `ui:*`. Those hints must merge UP by property name.
  test("merges a revealed field's `ui:*` up into the node's uiSchema", () => {
    const { schema, uiSchema } = splitUiSchema({
      type: "object",
      properties: { orderType: { type: "string", enum: ["standard", "wedding"] } },
      required: ["orderType"],
      dependencies: {
        orderType: {
          oneOf: [
            { properties: { orderType: { const: "standard" } } },
            {
              properties: {
                orderType: { const: "wedding" },
                bakerNotes: { type: "string", title: "Notes", "ui:widget": "textarea" },
              },
            },
          ],
        },
      },
    });
    // The hint lands at the TOP level keyed by the revealed field's name…
    expect(uiSchema).toEqual({ bakerNotes: { "ui:widget": "textarea" } });
    // …and is stripped from the branch schema, which is otherwise preserved.
    const branch = (schema.dependencies as any).orderType.oneOf[1];
    expect(branch.properties.bakerNotes).toEqual({ type: "string", title: "Notes" });
  });

  test("handles nested dependencies (a branch that reveals its own dependency)", () => {
    const { schema, uiSchema } = splitUiSchema({
      dependencies: {
        topper: {
          oneOf: [
            { properties: { topper: { const: false } } },
            {
              properties: {
                topper: { const: true },
                topperText: { type: "string", "ui:placeholder": "Congrats!" },
              },
            },
          ],
        },
      },
    });
    expect(uiSchema).toEqual({ topperText: { "ui:placeholder": "Congrats!" } });
    expect((schema.dependencies as any).topper.oneOf[1].properties.topperText).toEqual({ type: "string" });
  });

  test("copies a property dependency (string[]) verbatim", () => {
    const { schema, uiSchema } = splitUiSchema({
      dependencies: { creditCard: ["billingAddress"] },
    });
    expect(schema).toEqual({ dependencies: { creditCard: ["billingAddress"] } });
    expect(uiSchema).toEqual({});
  });
});

describe("splitUiSchema — combinators", () => {
  test("merges `anyOf` branch hints up by property name", () => {
    const { schema, uiSchema } = splitUiSchema({
      anyOf: [
        { properties: { a: { type: "string", "ui:widget": "password" } } },
        { properties: { b: { type: "number" } } },
      ],
    });
    expect(uiSchema).toEqual({ a: { "ui:widget": "password" } });
    expect((schema.anyOf as any)[0].properties.a).toEqual({ type: "string" });
  });

  test("merges `allOf` branch hints up by property name", () => {
    const { uiSchema } = splitUiSchema({
      allOf: [{ properties: { x: { type: "string", "ui:autofocus": true } } }],
    });
    expect(uiSchema).toEqual({ x: { "ui:autofocus": true } });
  });

  test("deep-merges two branches touching the same field", () => {
    const { uiSchema } = splitUiSchema({
      oneOf: [
        { properties: { field: { type: "string", "ui:widget": "textarea" } } },
        { properties: { field: { type: "string", "ui:placeholder": "hint" } } },
      ],
    });
    expect(uiSchema).toEqual({ field: { "ui:widget": "textarea", "ui:placeholder": "hint" } });
  });
});

describe("splitUiSchema — immutability", () => {
  test("does not mutate the input node", () => {
    const input = {
      type: "object",
      properties: { a: { type: "string", "ui:widget": "textarea" } },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    splitUiSchema(input);
    expect(input).toEqual(snapshot);
  });
});
