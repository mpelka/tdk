import { describe, expect, test } from "bun:test";
import type { MigrationModel } from "./model.ts";
import { buildNameMap, toConstName } from "./naming.ts";

describe("toConstName — the documented derivation rule", () => {
  test.each([
    ["bakeryCode", "bakeryCode"],
    ["bakery_code", "bakeryCode"],
    ["bakery-code", "bakeryCode"],
    ["Bakery Code", "bakeryCode"],
    ["job-summary", "jobSummary"],
    ["oven.asset.id", "ovenAssetId"],
    ["2fa", "_2fa"],
    ["", "field"],
    ["already", "already"],
  ])("%s -> %s", (input, expected) => {
    expect(toConstName(input)).toBe(expected);
  });
});

describe("buildNameMap — collision detection", () => {
  test("two questions that camel-case to the same const get numeric suffixes", () => {
    const model: MigrationModel = {
      modelVersion: "1",
      template: { id: "t", title: "T" },
      questions: [
        { name: "bakery-code", type: "string", page: "P" },
        { name: "bakery_code", type: "string", page: "P" },
        { name: "bakeryCode", type: "string", page: "P" },
      ],
    };
    const names = buildNameMap(model);
    expect(names.question.get("bakery-code")).toBe("bakeryCode");
    expect(names.question.get("bakery_code")).toBe("bakeryCode2");
    expect(names.question.get("bakeryCode")).toBe("bakeryCode3");
  });

  test("a const that would shadow a core import is suffixed", () => {
    const model: MigrationModel = {
      modelVersion: "1",
      template: { id: "t", title: "T" },
      questions: [{ name: "page", type: "string", page: "P" }],
    };
    expect(buildNameMap(model).question.get("page")).toBe("page2");
  });

  test("a const that would shadow an org-supplied import name is suffixed", () => {
    const model: MigrationModel = {
      modelVersion: "1",
      template: { id: "t", title: "T" },
      questions: [{ name: "createWorkOrder", type: "string", page: "P" }],
    };
    expect(buildNameMap(model, ["createWorkOrder"]).question.get("createWorkOrder")).toBe("createWorkOrder2");
  });

  test("step ids keep the verbatim name; only the const is camel-cased", () => {
    const model: MigrationModel = {
      modelVersion: "1",
      template: { id: "t", title: "T" },
      questions: [{ name: "x", type: "string", page: "P" }],
      logic: [{ name: "job-summary", op: "fieldRef", field: "x" }],
      effects: [{ name: "submit-request", kind: "k", actionRef: "a" }],
    };
    const names = buildNameMap(model);
    // The const is camel-cased…
    expect(names.logic.get("job-summary")).toBe("jobSummary");
    expect(names.effect.get("submit-request")).toBe("submitRequest");
    // …while the model name (used verbatim as the step id) is unchanged in the map key.
    expect([...names.logic.keys()]).toContain("job-summary");
    expect([...names.effect.keys()]).toContain("submit-request");
  });
});
