// Fidelity of `.when()` predicates (issue #24) — the emitted Nunjucks boolean vs
// how it actually evaluates. `compileWhenExpr` produces a SINGLE full `${{ … }}`
// block, so both the real Backstage `isTruthy` and core's `evalIf` take the
// identical "single expression → native value → coerce" path. These tests drive
// `execute()` (which calls `evalIf` for real): a step gated by the predicate is
// SKIPPED exactly when the predicate is false — proving `and`/`or`/`==`/`in`
// evaluate as the boolean algebra says, including the mixed `all(x, any(y, z))`
// nesting the schema layer cannot express.

import { describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { defineTemplate, step } from "./define.ts";
import { execute } from "./execute.ts";
import { page } from "./pages.ts";
import type { ShowWhenPredicate } from "./params.ts";
import { all, any, p } from "./params.ts";

type Params = { a: "x" | "o"; b: "y" | "o"; c: "z" | "w" } & Record<string, unknown>;

/** A template with a single step gated by `buildWhen(fields)`. */
function gated(id: string, buildWhen: (f: ReturnType<typeof fields>) => ShowWhenPredicate | ShowWhenPredicate[]) {
  const f = fields();
  return defineTemplate({
    id,
    title: id,
    type: "service",
    parameters: [page3(f)],
    steps: () => [step("gate", "debug:log", { when: buildWhen(f), input: { ok: "1" } })],
  });
}

function fields() {
  return {
    a: p.choice(["x", "o"], { title: "A", required: true }),
    b: p.choice(["y", "o"], { title: "B", required: true }),
    c: p.choice(["z", "w"], { title: "C", required: true }),
  };
}
function page3(f: ReturnType<typeof fields>) {
  return page("P", { a: f.a, b: f.b, c: f.c });
}

/** Run the template for `params` and report whether the gated step RAN (not skipped). */
async function gateRuns(tpl: ReturnType<typeof gated>, params: Params): Promise<boolean> {
  const { steps } = await execute(tpl, { parameters: params });
  return steps.gate?.skipped !== true;
}

describe("when fidelity — any(...) cross-field OR evaluates as `or`", () => {
  const tpl = gated("or-fidelity", (f) => any(f.a.is("x"), f.b.is("y")));

  test("the emitted expression is a single full ${{ … }} with `or`", () => {
    const s = compile(tpl, { env: "test", outDir: "" }).object.spec.steps[0]!;
    expect(s.if).toBe('${{ (parameters.a == "x") or (parameters.b == "y") }}');
  });

  // Truth table: RUN iff a=="x" OR b=="y".
  const cases: Array<[Params, boolean]> = [
    [{ a: "x", b: "y", c: "w" }, true],
    [{ a: "x", b: "o", c: "w" }, true],
    [{ a: "o", b: "y", c: "w" }, true],
    [{ a: "o", b: "o", c: "w" }, false],
  ];
  for (const [params, expected] of cases) {
    test(`a=${params.a} b=${params.b} → runs=${expected}`, async () => {
      expect(await gateRuns(tpl, params)).toBe(expected);
    });
  }
});

describe("when fidelity — all(x, any(y, z)) nests `and` over `or`", () => {
  const tpl = gated("all-any-fidelity", (f) => all(f.a.is("x"), any(f.b.is("y"), f.c.is("z"))));

  test("the emitted expression nests: (a) and ((b) or (c))", () => {
    const s = compile(tpl, { env: "test", outDir: "" }).object.spec.steps[0]!;
    expect(s.if).toBe('${{ (parameters.a == "x") and ((parameters.b == "y") or (parameters.c == "z")) }}');
  });

  // Truth table: RUN iff a=="x" AND (b=="y" OR c=="z").
  const cases: Array<[Params, boolean]> = [
    [{ a: "x", b: "y", c: "w" }, true], // a & (b)
    [{ a: "x", b: "o", c: "z" }, true], // a & (c)
    [{ a: "x", b: "o", c: "w" }, false], // a but neither
    [{ a: "o", b: "y", c: "z" }, false], // not a
  ];
  for (const [params, expected] of cases) {
    test(`a=${params.a} b=${params.b} c=${params.c} → runs=${expected}`, async () => {
      expect(await gateRuns(tpl, params)).toBe(expected);
    });
  }
});

describe("when fidelity — a bare condition and an all(...) AND still agree", () => {
  test("single condition: runs iff a=='x'", async () => {
    const tpl = gated("single", (f) => f.a.is("x"));
    expect(await gateRuns(tpl, { a: "x", b: "o", c: "w" })).toBe(true);
    expect(await gateRuns(tpl, { a: "o", b: "o", c: "w" })).toBe(false);
  });

  test("all(a.is('x'), b.is('y')): runs iff both", async () => {
    const tpl = gated("and", (f) => all(f.a.is("x"), f.b.is("y")));
    expect(await gateRuns(tpl, { a: "x", b: "y", c: "w" })).toBe(true);
    expect(await gateRuns(tpl, { a: "x", b: "o", c: "w" })).toBe(false);
  });
});
