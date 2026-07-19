import { describe, expect, test } from "bun:test";
import { corpus } from "./__fixtures__/corpus.ts";
import type { MigrationModel } from "./model.ts";
import { formatModelErrors, validateModel } from "./validate.ts";

/** A minimal valid model, for targeted mutation in the reject tests. */
function baseModel(): MigrationModel {
  return {
    modelVersion: "1",
    template: { id: "t", title: "T" },
    questions: [
      {
        name: "severity",
        type: "choice",
        options: { low: "Low", urgent: "Urgent" },
        page: "P",
        exampleValue: "urgent",
      },
      { name: "note", type: "string", page: "P" },
    ],
  };
}

describe("validateModel — accept", () => {
  test("the full corpus (every node kind) validates", () => {
    const result = validateModel(corpus);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a minimal model validates", () => {
    expect(validateModel(baseModel()).valid).toBe(true);
  });
});

describe("validateModel — schema (gate 0 shape errors)", () => {
  test("a missing required top-level field is rejected with a path", () => {
    const { template, ...noQuestions } = { ...baseModel(), questions: undefined } as unknown as MigrationModel;
    void template;
    const result = validateModel(noQuestions);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /questions/.test(e.message) || /questions/.test(e.path))).toBe(true);
  });

  test("a wrong modelVersion is rejected", () => {
    const result = validateModel({ ...baseModel(), modelVersion: "2" });
    expect(result.valid).toBe(false);
  });

  test("an unknown question type is rejected and lists the allowed values", () => {
    const m = baseModel();
    (m.questions[0] as { type: string }).type = "dropdown";
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain("choice");
  });

  test("an unknown property is rejected by name", () => {
    const m = baseModel() as unknown as Record<string, unknown>;
    (m.questions as Array<Record<string, unknown>>)[0].colour = "red";
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain('unknown property "colour"');
  });
});

describe("validateModel — semantic checks + typo suggestions", () => {
  test("a visibleWhen field that is not a question is flagged with a suggestion", () => {
    const m = baseModel();
    m.questions.push({ name: "detail", type: "string", page: "P", visibleWhen: { field: "sevrity", is: "urgent" } });
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toBe(
      'questions[2].visibleWhen.field: "sevrity" is not a declared question (did you mean "severity"?)',
    );
  });

  test("an effect input {ref} to an undeclared name is flagged with a suggestion", () => {
    const m = baseModel();
    m.effects = [{ name: "go", kind: "k", actionRef: "legacy:x", inputs: { s: { ref: "svrity" } } }];
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toBe(
      'effects[0].inputs.s: "svrity" is not a declared question, logic node, or lookup (did you mean "severity"?)',
    );
  });

  test("a logic fieldRef to an undeclared question is flagged with a suggestion", () => {
    const m = baseModel();
    m.logic = [{ name: "sum", op: "template", template: "{x}", bindings: { x: { op: "fieldRef", field: "note2" } } }];
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toBe(
      'logic[0].bindings.x.field: "note2" is not a declared question (did you mean "note"?)',
    );
  });

  test("a duplicate question name is flagged", () => {
    const m = baseModel();
    m.questions.push({ name: "note", type: "string", page: "P" });
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain('duplicate name "note" within questions');
  });

  test("a name reused across kinds is flagged as ambiguous", () => {
    const m = baseModel();
    m.logic = [{ name: "note", op: "literal", value: "x" }];
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain('name "note" is also declared in questions');
  });

  test("an effectRef to an undeclared effect is flagged", () => {
    const m = baseModel();
    m.outputs = { id: { effectRef: "nope" } };
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain('"nope" is not a declared effect');
  });

  test("a lookupRef to an undeclared lookup is flagged", () => {
    const m = baseModel();
    m.effects = [{ name: "go", kind: "k", actionRef: "legacy:x", inputs: { a: { lookupRef: "missing" } } }];
    const result = validateModel(m);
    expect(result.valid).toBe(false);
    expect(formatModelErrors(result.errors)).toContain('"missing" is not a declared lookup');
  });

  test("a listMap item reference does not trip the fieldRef check", () => {
    const m = baseModel();
    m.questions.push({ name: "items", type: "array", page: "P" });
    m.logic = [
      {
        name: "mapped",
        op: "listMap",
        source: { op: "fieldRef", field: "items" },
        as: "it",
        body: { op: "fieldRef", field: "it" },
      },
    ];
    expect(validateModel(m).valid).toBe(true);
  });
});
