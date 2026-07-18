// Runtime + compile tests for `derive` (ADR-0025 Decision 2, phase 3a): the
// generated roadie steps, topological planning, auto-wiring, the three loud
// conditions (cycle, duplicate name, unreachable warning), and cross-template
// independence.

import { beforeEach, describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { defineTemplate, step } from "./define.ts";
import { _resetDeriveRegistry, derive, getDeriveExpr, isDeriveHandle } from "./derive.ts";
import { nj } from "./expr/nunjucks/index.ts";
import { p } from "./params.ts";

const target = { env: "test", outDir: "" } as const;

// A fresh registry per test so the unreachable-derive scan sees only this test's
// declarations (the registry is process-wide — see `declaredDerives`).
beforeEach(() => {
  _resetDeriveRegistry();
});

describe("derive — generated step", () => {
  test("compiles to a roadie jsonata step: data from inputs, expression from the lambda", () => {
    const severity = p.choice(["low", "urgent"], { title: "Severity" });
    const sla = derive("sla-hours", { severity }, (i) => (i.severity === "urgent" ? 4 : 24));
    const tpl = defineTemplate({
      id: "t",
      title: "T",
      type: "service",
      parameters: { severity },
      steps: () => [step("log", "debug:log", { input: { hours: sla } })],
    });
    const { object } = compile(tpl, target);
    const derived = object.spec.steps.find((s) => s.id === "sla-hours")!;
    expect(derived.action).toBe("roadiehq:utils:jsonata");
    expect(derived.name).toBe("Sla Hours"); // title-cased id, by default
    const input = derived.input as { data: Record<string, string>; expression: string };
    // The data map is exactly the referenced input, rendered as a ref.
    expect(input.data).toEqual({ severity: "${{ parameters.severity }}" });
    expect(input.expression).toContain("severity");
    expect(input.expression).not.toContain("${{");
  });

  test("the user-visible name is overridable", () => {
    const n = p.number();
    const doubled = derive("doubled", { n }, (i) => i.n * 2, { name: "Double the number" });
    const tpl = defineTemplate({
      id: "t2",
      title: "T2",
      type: "service",
      parameters: { n },
      steps: () => [step("log", "debug:log", { input: { v: doubled } })],
    });
    const { object } = compile(tpl, target);
    expect(object.spec.steps.find((s) => s.id === "doubled")!.name).toBe("Double the number");
  });

  test("consuming a handle auto-wires the step reference; sub-refs append the path", () => {
    const n = p.number();
    const obj = derive("obj", { n }, (i) => ({ label: `n=${i.n}`, doubled: i.n * 2 }));
    const tpl = defineTemplate({
      id: "t3",
      title: "T3",
      type: "service",
      parameters: { n },
      steps: () => [step("log", "debug:log", { input: { whole: obj, part: obj.label } })],
    });
    const { object } = compile(tpl, target);
    const input = object.spec.steps.find((s) => s.id === "log")!.input as Record<string, string>;
    expect(input.whole).toBe("${{ steps['obj'].output.result }}");
    expect(input.part).toBe("${{ steps['obj'].output.result.label }}");
  });

  test("isDeriveHandle / getDeriveExpr introspect a handle", () => {
    const n = p.number();
    const h = derive("h", { n }, (i) => i.n + 1);
    const objH = derive("objh", { n }, (i) => ({ v: i.n }));
    expect(isDeriveHandle(h)).toBe(true);
    expect(isDeriveHandle(objH.v)).toBe(true); // a sub-ref is a handle too
    expect(isDeriveHandle({})).toBe(false);
    expect(getDeriveExpr(h).jsonata).toContain("n");
    expect(() => getDeriveExpr({} as never)).toThrow(/not a derive handle/);
  });
});

describe("derive — topological planning", () => {
  test("a derive referenced only by output is still emitted (output is a root)", () => {
    const name = p.string();
    const tag = derive("tag", { name }, (i) => `#${i.name}`);
    const tpl = defineTemplate({
      id: "out",
      title: "Out",
      type: "service",
      parameters: { name },
      steps: () => [step("noop", "debug:log", { input: { msg: "hi" } })],
      output: () => ({ tag }),
    });
    const { object } = compile(tpl, target);
    expect(object.spec.steps.map((s) => s.id)).toContain("tag");
    expect(object.spec.output).toEqual({ tag: "${{ steps['tag'].output.result }}" });
  });

  test("SSA interleaving: manual step -> derive reading it -> manual step reading the derive", () => {
    const asset = p.string();
    const ctx = derive("ctx", { model: nj((c) => c.steps["lookup"].output.model) }, (i) => `model ${i.model}`);
    const tpl = defineTemplate({
      id: "ssa",
      title: "SSA",
      type: "service",
      parameters: { asset },
      steps: () => [
        step("lookup", "svc:fetch", { input: { asset: asset.ref } }),
        step("register", "svc:register", { input: { context: ctx } }),
      ],
    });
    const { object } = compile(tpl, target);
    const order = object.spec.steps.map((s) => s.id);
    expect(order.indexOf("lookup")).toBeLessThan(order.indexOf("ctx"));
    expect(order.indexOf("ctx")).toBeLessThan(order.indexOf("register"));
  });

  test("existing templates (no derives) keep their step order unchanged", () => {
    const tpl = defineTemplate({
      id: "plain",
      title: "Plain",
      type: "service",
      parameters: { x: p.string() },
      steps: (f) => [step("a", "debug:log", { input: { x: f.x } }), step("b", "debug:log", { input: { y: "z" } })],
    });
    const { object, diagnostics } = compile(tpl, target);
    expect(object.spec.steps.map((s) => s.id)).toEqual(["a", "b"]);
    expect(diagnostics).toBeUndefined();
  });
});

describe("derive — the loud conditions", () => {
  test("a dependency cycle among derives is a loud compile error", () => {
    // Two derives reference each other by step name (via nj markers) — a cycle.
    const seed = p.string();
    const a = derive("cyc-a", { from: nj((c) => c.steps["cyc-b"].output.result) }, (i) => `a${i.from}`);
    const b = derive("cyc-b", { from: nj((c) => c.steps["cyc-a"].output.result) }, (i) => `b${i.from}`);
    const tpl = defineTemplate({
      id: "cyc",
      title: "Cyc",
      type: "service",
      parameters: { seed },
      steps: () => [step("log", "debug:log", { input: { a, b } })],
    });
    expect(() => compile(tpl, target)).toThrow(/cycle/i);
  });

  test("two distinct derives sharing a name is a loud compile error", () => {
    const x = p.string();
    const y = p.string();
    const d1 = derive("dup", { x }, (i) => i.x);
    const d2 = derive("dup", { y }, (i) => i.y);
    const tpl = defineTemplate({
      id: "dupt",
      title: "Dup",
      type: "service",
      parameters: { x, y },
      steps: () => [step("log", "debug:log", { input: { a: d1, b: d2 } })],
    });
    expect(() => compile(tpl, target)).toThrow(/duplicate derived-value name "dup"/);
  });

  test("a derive name colliding with a manual step id is a loud compile error", () => {
    const x = p.string();
    const d = derive("clash", { x }, (i) => i.x);
    const tpl = defineTemplate({
      id: "clasht",
      title: "Clash",
      type: "service",
      parameters: { x },
      steps: () => [step("clash", "debug:log", { input: { m: "hi" } }), step("use", "debug:log", { input: { v: d } })],
    });
    expect(() => compile(tpl, target)).toThrow(/collides with a manual step id/);
  });

  test("a declared-but-unreachable derive is excluded, with a loud diagnostic", () => {
    const x = p.string();
    const used = derive("used", { x }, (i) => i.x);
    // `unused` is declared but never referenced.
    derive("unused", { x }, (i) => `${i.x}!`);
    const tpl = defineTemplate({
      id: "unreach",
      title: "Unreach",
      type: "service",
      parameters: { x },
      steps: () => [step("log", "debug:log", { input: { v: used } })],
    });
    const { object, diagnostics } = compile(tpl, target);
    // The unreachable derive is NOT emitted…
    expect(object.spec.steps.map((s) => s.id)).not.toContain("unused");
    expect(object.spec.steps.map((s) => s.id)).toContain("used");
    // …and a diagnostic names it.
    expect(diagnostics).toBeDefined();
    expect(diagnostics!.some((d) => d.includes('"unused"') && d.includes("not reachable"))).toBe(true);
  });
});

describe("derive — cross-template independence", () => {
  test("one derive used by two templates yields an independent step instance in each", () => {
    const label = p.string();
    const shared = derive("shared", { label }, (i) => `[${i.label}]`);
    const make = (id: string) =>
      defineTemplate({
        id,
        title: id,
        type: "service",
        parameters: { label },
        steps: () => [step("log", "debug:log", { input: { v: shared } })],
      });
    const a = compile(make("tpl-a"), target).object;
    const b = compile(make("tpl-b"), target).object;
    // Each template emits its own `shared` step; the per-template name uniqueness
    // does not collide across templates.
    expect(a.spec.steps.find((s) => s.id === "shared")?.action).toBe("roadiehq:utils:jsonata");
    expect(b.spec.steps.find((s) => s.id === "shared")?.action).toBe("roadiehq:utils:jsonata");
    expect(a.metadata.name).toBe("tpl-a");
    expect(b.metadata.name).toBe("tpl-b");
  });
});
