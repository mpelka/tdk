// Direct unit tests for `executeScenarios` — the scenario playground the VS Code
// extension shells out to. Assert on the RETURNED report object + its serialized
// form (the byte-for-byte JSON contract), no subprocess.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { GREETING_TEMPLATE, makePkgTmp, scaffoldTemplate } from "./__fixtures__/scaffold.ts";
import { executeInlineFixture, executeScenarios, parseInlineFixture, serializeExecuteReport } from "./execute.ts";

let pkgTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

describe("executeScenarios", () => {
  test("runs every scenario and returns { ok: true, scenarios } (default test env)", async () => {
    const report = await executeScenarios(GREETING_TEMPLATE, { fromStdin: false, env: "test" });
    expect(report.ok).toBe(true);
    expect(report.scenarios).toHaveLength(1);
    const first = report.scenarios[0]!;
    expect(first.name).toBe("orders for alice");
    if (!("result" in first)) throw new Error("expected a result");
    expect((first.result.steps.order as { input: { cluster: string } }).input.cluster).toBe("test-cluster");
  });

  test("each scenario carries its fixture parameters, a step-mock flag, and the mocks (form-preview prefill + trace)", async () => {
    const report = await executeScenarios(GREETING_TEMPLATE, { fromStdin: false, env: "test" });
    const first = report.scenarios[0]!;
    // The additive fields the form preview reads to PREFILL and drive the trace.
    expect(first.parameters).toEqual({ customer: "Alice" });
    expect(first.hasStepMocks).toBe(true);
    // The actual mocks ride along so the extension can reuse them as the trace base.
    expect(first.steps).toEqual({ order: { output: {} } });
  });

  test("a scenario with NO step mocks reports hasStepMocks:false, still with parameters", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "exec-no-mocks", {
      scenarios: `export const scenarios = [
  { name: "no mocks", fixture: { parameters: { customer: "Bo" } } },
];
`,
    });
    const report = await executeScenarios(join(dir, "template.ts"), { fromStdin: false, env: "test" });
    const s = report.scenarios[0]!;
    expect(s.parameters).toEqual({ customer: "Bo" });
    expect(s.hasStepMocks).toBe(false);
    // No mocks → the `steps` field is omitted entirely (not an empty object).
    expect(s.steps).toBeUndefined();
  });

  test("a broken (undefined) fixture still reports its inputs — parameters undefined, hasStepMocks:false", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "exec-broken-inputs", {
      scenarios: `export const scenarios = [
  { name: "broken", fixture: undefined },
];
`,
    });
    const report = await executeScenarios(join(dir, "template.ts"), { fromStdin: false, env: "test" });
    const s = report.scenarios[0]!;
    expect("error" in s).toBe(true);
    expect(s.parameters).toBeUndefined();
    expect(s.hasStepMocks).toBe(false);
  });

  test("--env prod threads the env into the run", async () => {
    const report = await executeScenarios(GREETING_TEMPLATE, { fromStdin: false, env: "prod" });
    const first = report.scenarios[0]!;
    if (!("result" in first)) throw new Error("expected a result");
    expect((first.result.steps.order as { input: { cluster: string } }).input.cluster).toBe("prod-cluster");
  });

  test("a broken scenario yields a per-scenario error object; the rest still run", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "exec-scenario-error", {
      scenarios: `export const scenarios = [
  { name: "good", fixture: { parameters: { who: "A" }, steps: { greet: { output: {} } } } },
  { name: "broken", fixture: undefined },
];
`,
    });
    const report = await executeScenarios(join(dir, "template.ts"), { fromStdin: false, env: "test" });
    expect(report.ok).toBe(true);
    expect(report.scenarios).toHaveLength(2);
    expect("result" in report.scenarios[0]!).toBe(true);
    const broken = report.scenarios[1]!;
    expect(broken.name).toBe("broken");
    expect("error" in broken && typeof broken.error).toBe("string");
  });

  test("a scenarios file that fails to load is a HARD error (not zero scenarios)", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "exec-broken-scenarios", { scenarios: "const x =\n" });
    const err = await executeScenarios(join(dir, "template.ts"), { fromStdin: false, env: "test" }).catch(
      (e) => e as Error,
    );
    expect((err as Error).message).toContain("scenarios.ts");
  });

  test("a missing file argument throws a usage error", async () => {
    expect(executeScenarios(undefined, { fromStdin: false, env: "test" })).rejects.toThrow(/Usage: tdk execute/);
  });
});

describe("executeInlineFixture (the live-trace path)", () => {
  test("runs ONE inline fixture (never the scenarios file) and returns { ok: true, result }", async () => {
    const report = await executeInlineFixture(
      GREETING_TEMPLATE,
      { parameters: { customer: "Zoe" }, steps: { order: { output: {} } } },
      "test",
    );
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    // The resolved input reflects the INLINE parameters, not any scenario's.
    expect((report.result.steps.order as { input: { message: string } }).input.message).toBe("Order for Zoe!");
  });

  test("threads the env into the inline run", async () => {
    const report = await executeInlineFixture(GREETING_TEMPLATE, { parameters: { customer: "Zoe" } }, "prod");
    if (!report.ok) throw new Error("expected ok");
    expect((report.result.steps.order as { input: { cluster: string } }).input.cluster).toBe("prod-cluster");
  });

  test("a per-step run error surfaces honestly in the result (not thrown, not a failure)", async () => {
    // A jsonata step whose `assert` guard fails for this fixture — the run still
    // SUCCEEDS, and the step carries an `error` field. That is exactly the "render
    // it honestly, it's informative" behaviour the trace pane depends on.
    const dir = await scaffoldTemplate(pkgTmp, "exec-inline-error", {
      template: `import { defineTemplate, jsonata, p, step } from "@tdk/core";
export default defineTemplate({
  id: "assert-fixture", title: "Assert", description: "d", type: "service",
  parameters: { who: p.string({ title: "Who" }) },
  steps: () => [
    step("guard", "roadiehq:utils:jsonata", {
      name: "Guard",
      input: { expression: jsonata<{ who: string }>((c) => assert(c.who !== "", "who required")).compact },
    }),
  ],
});
`,
    });
    const report = await executeInlineFixture(join(dir, "template.ts"), { parameters: { who: "" } }, "test");
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("expected ok");
    expect((report.result.steps.guard as { error?: string }).error).toBe("who required");
  });

  test("a missing file argument throws a usage error", () => {
    expect(executeInlineFixture(undefined, { parameters: {} }, "test")).rejects.toThrow(
      /Usage: tdk execute --fixture-stdin/,
    );
  });
});

describe("parseInlineFixture", () => {
  test("parses a JSON object with a `parameters` field", () => {
    const fixture = parseInlineFixture('{"parameters":{"a":1},"steps":{"s":{"output":{}}}}');
    expect(fixture.parameters).toEqual({ a: 1 });
    expect(fixture.steps).toEqual({ s: { output: {} } });
  });

  test("rejects non-JSON with a clear message", () => {
    expect(() => parseInlineFixture("not json")).toThrow(/JSON fixture on stdin/);
  });

  test("rejects a non-object (an array)", () => {
    expect(() => parseInlineFixture("[]")).toThrow(/JSON object with a `parameters` field/);
  });

  test("rejects a fixture missing an object `parameters`", () => {
    expect(() => parseInlineFixture('{"steps":{}}')).toThrow(/object `parameters` field/);
  });
});

describe("serializeExecuteReport", () => {
  test("emits compact JSON with a trailing newline", () => {
    const out = serializeExecuteReport({ ok: true, scenarios: [] });
    expect(out).toBe('{"ok":true,"scenarios":[]}\n');
  });

  test("serializes an inline report too (the { ok, result } shape)", () => {
    const out = serializeExecuteReport({ ok: false, error: "boom" });
    expect(out).toBe('{"ok":false,"error":"boom"}\n');
  });
});
