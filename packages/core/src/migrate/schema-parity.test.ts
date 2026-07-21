import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { corpus, corpusMapping } from "./__fixtures__/corpus.ts";
import type { MigrationModel } from "./model.ts";
import { modelSchema } from "./schema.ts";

// The JSON Schema is the public contract, and the TypeScript types are its sibling.
// This suite pins schema-accepts ⇔ types-accept: every fixture below is TYPED as
// `MigrationModel` (so `tsc` accepts it) AND asserted schema-valid; the negative
// fixtures are asserted schema-invalid.

const validate = new Ajv({ allErrors: true, strict: false }).compile(modelSchema());

/** A corpus of typed-valid models — each covers one or more node kinds. */
const typedValid: MigrationModel[] = [
  corpus,
  { modelVersion: "1", template: { id: "a", title: "A" }, questions: [{ name: "x", type: "string", page: "P" }] },
  {
    modelVersion: "1",
    template: {
      id: "b",
      title: "B",
      type: "service",
      tags: ["t"],
      owner: "o",
      description: "d",
      // The escape hatch: free-form (a hyphenated key, nested arrays/objects) — accepted
      // by both the TS type (JsonObject) and the `{ "type": "object" }` schema.
      extraSpec: { "catalog-metadata": { category: "Catering", tiers: [1, 2], meta: { a: true } } },
    },
    questions: [
      {
        name: "c",
        type: "choice",
        options: { a: "A", b: "B" },
        required: true,
        default: "a",
        exampleValue: "a",
        page: "P",
      },
      { name: "n", type: "number", minimum: 0, maximum: 9, page: "P" },
      { name: "bo", type: "boolean", page: "P" },
      { name: "ar", type: "array", items: { type: "string" }, page: "P" },
      {
        name: "st",
        type: "string",
        format: "email",
        pattern: "^.+$",
        minLength: 1,
        maxLength: 9,
        uiWidget: "textarea",
        uiOptions: { rows: 5 },
        page: "P",
      },
      // A customField: uiField + customType, an object exampleValue, uiOptions — the
      // Backstage field-extension escape hatch, accepted by both the TS type and schema.
      {
        name: "cf",
        type: "customField",
        title: "Cake line",
        uiField: "CakePickerWithDefault",
        customType: "object",
        uiOptions: { path: "bakery-catalog/entities" },
        exampleValue: { id: "cl-1", name: "Sponge" },
        page: "P",
      },
    ],
    logic: [
      { name: "t1", op: "template", template: "{a}", bindings: { a: { op: "fieldRef", field: "st" } } },
      {
        name: "c1",
        op: "concat",
        parts: [
          { op: "literal", value: "x" },
          { op: "logicRef", ref: "t1" },
        ],
      },
      {
        name: "cond1",
        op: "conditional",
        cases: [{ when: { field: "c", is: "a" }, then: { op: "literal", value: 1 } }],
        else: { op: "literal", value: 2 },
      },
      {
        name: "lm1",
        op: "listMap",
        source: { op: "fieldRef", field: "ar" },
        as: "el",
        body: { op: "fieldRef", field: "el" },
      },
      { name: "esc1", kind: "expression", language: "nunjucks", source: "${{ x }}" },
    ],
    lookups: [{ name: "lk", kind: "roster", source: "roster://x", params: { s: { op: "fieldRef", field: "c" } } }],
    effects: [
      {
        name: "e1",
        kind: "k",
        actionRef: "legacy:x",
        inputs: { a: { ref: "c" }, b: { literal: 1 }, d: { lookupRef: "lk" } },
        when: { field: "c", is: "a" },
      },
    ],
    outputs: { id: { effectRef: "e1", path: ["body", "id"] }, v: { logicRef: "cond1" } },
  },
];

describe("schema-parity: types-accept ⇒ schema-accepts", () => {
  test.each(
    typedValid.map((m, i) => [i, m] as const),
  )("typed-valid fixture #%i validates against the schema", (_i, model) => {
    const ok = validate(model);
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2));
    expect(ok).toBe(true);
  });

  test("the corpus mapping is a plain object (no schema needed, but present)", () => {
    expect(corpusMapping.actions).toBeDefined();
  });
});

describe("schema rejects malformed documents", () => {
  const invalid: Array<[string, unknown]> = [
    ["missing modelVersion", { template: { id: "a", title: "A" }, questions: [] }],
    ["missing template", { modelVersion: "1", questions: [] }],
    [
      "question without page",
      { modelVersion: "1", template: { id: "a", title: "A" }, questions: [{ name: "x", type: "string" }] },
    ],
    [
      "empty page tag",
      { modelVersion: "1", template: { id: "a", title: "A" }, questions: [{ name: "x", type: "string", page: "" }] },
    ],
    [
      "unknown property",
      {
        modelVersion: "1",
        template: { id: "a", title: "A" },
        questions: [{ name: "x", type: "string", page: "P", nope: 1 }],
      },
    ],
    [
      "bad visibleWhen shape",
      {
        modelVersion: "1",
        template: { id: "a", title: "A" },
        questions: [{ name: "x", type: "string", page: "P", visibleWhen: { field: "y" } }],
      },
    ],
    [
      "logic node without a name",
      { modelVersion: "1", template: { id: "a", title: "A" }, questions: [], logic: [{ op: "literal", value: 1 }] },
    ],
    [
      "effect without actionRef",
      { modelVersion: "1", template: { id: "a", title: "A" }, questions: [], effects: [{ name: "e", kind: "k" }] },
    ],
    [
      "customType of a non-string type",
      {
        modelVersion: "1",
        template: { id: "a", title: "A" },
        questions: [{ name: "x", type: "customField", uiField: "CakePickerWithDefault", customType: 5, page: "P" }],
      },
    ],
  ];
  test.each(invalid)("rejects: %s", (_label, doc) => {
    expect(validate(doc)).toBe(false);
  });
});
