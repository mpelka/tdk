import { describe, expect, test } from "bun:test";
import { assertValid, compile, getValidator, p, structuralCheck, Template, validate } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

class Valid extends Template {
  id = "valid";
  title = "Valid";
  type = "service";
  params = { name: p.string() };
  build() {
    return [{ id: "s", action: "debug:log" }];
  }
}

describe("ajv validate / assertValid", () => {
  test("getValidator caches a single compiled validator", async () => {
    const a = await getValidator();
    const b = await getValidator();
    expect(a).toBe(b);
  });

  test("assertValid resolves for a schema-valid entity", async () => {
    const { object } = compile(new Valid(), nonprod);
    await expect(assertValid(object)).resolves.toBeUndefined();
  });

  test("assertValid throws a readable error for an invalid entity", async () => {
    await expect(assertValid({ apiVersion: "wrong" })).rejects.toThrow(/failed schema validation/);
  });

  test("validate returns the ajv error list for an invalid entity", async () => {
    const { valid, errors } = await validate({
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      // missing metadata + spec
    });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("structuralCheck (schema-lite)", () => {
  test("non-object input fails fast", () => {
    expect(structuralCheck(null).valid).toBe(false);
    expect(structuralCheck("nope").valid).toBe(false);
  });

  test("wrong apiVersion / kind are flagged", () => {
    const { valid, errors } = structuralCheck({
      apiVersion: "v1",
      kind: "Component",
      metadata: { name: "x" },
      spec: { type: "service", steps: [{ action: "debug:log" }] },
    });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.instancePath === "/apiVersion")).toBe(true);
    expect(errors.some((e) => e.instancePath === "/kind")).toBe(true);
  });

  test("missing metadata.name is flagged", () => {
    const { errors } = structuralCheck({
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      metadata: {},
      spec: { type: "service", steps: [{ action: "debug:log" }] },
    });
    expect(errors.some((e) => e.instancePath === "/metadata/name")).toBe(true);
  });

  test("missing spec is flagged", () => {
    const { errors } = structuralCheck({
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      metadata: { name: "x" },
    });
    expect(errors.some((e) => e.instancePath === "/spec")).toBe(true);
  });

  test("missing spec.type is flagged", () => {
    const { errors } = structuralCheck({
      apiVersion: "scaffolder.backstage.io/v1beta3",
      kind: "Template",
      metadata: { name: "x" },
      spec: { steps: [{ action: "debug:log" }] },
    });
    expect(errors.some((e) => e.instancePath === "/spec/type")).toBe(true);
  });

  test("a fully valid entity passes", () => {
    const { object } = compile(new Valid(), nonprod);
    expect(structuralCheck(object).valid).toBe(true);
  });
});
