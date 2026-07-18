// Runtime + compile tests for `derive` (ADR-0025 Decision 2, phase 3a): the
// generated roadie steps, topological planning, auto-wiring, the three loud
// conditions (cycle, duplicate name, unreachable warning), cross-template
// independence, sub-ref injection guarding, and env.pick edge collection.

import { beforeEach, describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { defineTemplate, step } from "./define.ts";
import { _resetDeriveRegistry, derive, getDeriveExpr, isDeriveHandle } from "./derive.ts";
import { env } from "./env.ts";
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

  test("one template's orphan derive does not surface in another template's diagnostics", () => {
    // Template A declares a reachable derive and an ORPHAN, both reading A's
    // param. Template B (its own params, no derives) must compile with CLEAN
    // diagnostics — A's orphan is attributed to A by ref identity, and only A's
    // compile reports it.
    const xA = p.string();
    const usedA = derive("used-a", { xA }, (i) => i.xA);
    derive("orphan-a", { xA }, (i) => `${i.xA}!`);
    const tplA = defineTemplate({
      id: "attr-a",
      title: "A",
      type: "service",
      parameters: { xA },
      steps: () => [step("log", "debug:log", { input: { v: usedA } })],
    });
    const xB = p.string();
    const tplB = defineTemplate({
      id: "attr-b",
      title: "B",
      type: "service",
      parameters: { xB },
      steps: (f) => [step("log", "debug:log", { input: { v: f.xB } })],
    });
    const a = compile(tplA, target);
    const b = compile(tplB, target);
    // A's own compile names its orphan…
    expect(a.diagnostics).toBeDefined();
    expect(a.diagnostics!.some((d) => d.includes('"orphan-a"'))).toBe(true);
    // …and B's compile is clean: neither A's orphan nor A's used derive leaks.
    expect(b.diagnostics).toBeUndefined();
  });
});

describe("derive — sub-ref key validation (injection guard)", () => {
  test("a non-identifier sub-ref key throws at access, naming the derive and the key", () => {
    const n = p.number();
    const h = derive("guarded", { n }, (i) => ({ label: `n=${i.n}` }));
    const probe = h as unknown as Record<string, unknown>;
    // The breakout probe: a key that would terminate the ${{ }} block and open
    // another — must throw at ACCESS, never reach the emitted expression.
    const probes = [
      "x'] }} injected {{ '", // the expression-breakout probe
      "a}}b", // closes the interpolation block
      "a b", // whitespace
      "a\nb", // newline
      "🎂", // non-identifier unicode
      "it's", // a quote
      "0", // digit-leading (not a Nunjucks dot-path segment)
    ];
    for (const key of probes) {
      expect(() => probe[key]).toThrow(/not a plain identifier/);
      expect(() => probe[key]).toThrow('"guarded"');
    }
    // A plain identifier key still sub-refs.
    expect(String(h.label)).toBe("${{ steps['guarded'].output.result.label }}");
  });
});

describe("derive — env.pick inputs contribute planning edges", () => {
  test("a step reference inside ANY env.pick branch orders the derive after that step, in every env", () => {
    // The verifier's probe shape: the derive's input is an env.pick whose
    // branches read DIFFERENT manual steps per env. The planner must union the
    // branches, so the derive lands after BOTH steps in BOTH artifacts —
    // conservative ordering is correct ordering.
    const seed = p.string();
    const picked = derive(
      "picked",
      {
        v: env.pick({
          test: nj((c) => c.steps["step-a"].output.v),
          prod: nj((c) => c.steps["step-b"].output.v),
        }),
      },
      (i) => `v=${i.v}`,
    );
    const tpl = defineTemplate({
      id: "envpick-edges",
      title: "EnvPick Edges",
      type: "service",
      parameters: { seed },
      steps: (f) => [
        step("step-a", "svc:a", { input: { s: f.seed } }),
        step("step-b", "svc:b", { input: { s: f.seed } }),
        step("use", "debug:log", { input: { v: picked } }),
      ],
    });
    for (const envName of ["test", "prod"]) {
      const { object } = compile(tpl, { env: envName, outDir: "" }, { checkEnvSafety: false });
      const order = object.spec.steps.map((s) => s.id);
      // Both referenced steps precede the derive; the derive precedes its consumer.
      expect(order.indexOf("step-a")).toBeLessThan(order.indexOf("picked"));
      expect(order.indexOf("step-b")).toBeLessThan(order.indexOf("picked"));
      expect(order.indexOf("picked")).toBeLessThan(order.indexOf("use"));
      // The emitted data holds the env's OWN branch.
      const data = (object.spec.steps.find((s) => s.id === "picked")!.input as { data: Record<string, string> }).data;
      expect(data.v).toBe(envName === "test" ? '${{ steps["step-a"].output.v }}' : '${{ steps["step-b"].output.v }}');
    }
  });

  test("a derive handle inside an env.pick branch is reachable (emitted) in every env", () => {
    const seed = p.string();
    const inner = derive("inner", { seed }, (i) => `#${i.seed}`);
    const tpl = defineTemplate({
      id: "envpick-reach",
      title: "EnvPick Reach",
      type: "service",
      parameters: { seed },
      steps: () => [
        step("log", "debug:log", {
          input: { v: env.pick({ test: inner, prod: "literal" }) },
        }),
      ],
    });
    for (const envName of ["test", "prod"]) {
      const { object } = compile(tpl, { env: envName, outDir: "" }, { checkEnvSafety: false });
      // The union makes `inner` reachable in BOTH envs — a missing step in the
      // env that picks the handle branch would be a broken artifact.
      expect(object.spec.steps.map((s) => s.id)).toContain("inner");
    }
  });
});
