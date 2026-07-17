// Unit tests for the `execute(...)` scenario simulator.
//
// A small synthetic template exercises every engine branch: pure
// (`roadiehq:utils:jsonata`) steps computed for real, an `$assert` guard that
// throws, mocked non-pure steps, `if` in all its forms (absent / boolean /
// full-`${{ }}` / embedded), single-expression TYPE preservation (object/array),
// embedded string interpolation, and the gold-standard differential (matching +
// diverging, incl. the assert-throws path).

import { beforeEach, describe, expect, test } from "bun:test";
import type { Step } from "./index.ts";
import {
  _resetActionSimulators,
  assert,
  assertExecuteAgainstGold,
  defineAction,
  defineTemplate,
  execute,
  executeAgainstGold,
  jsonata,
  nj,
  p,
  raw,
  registerActionSimulator,
  step,
  Template,
} from "./index.ts";

// The simulator registry is GLOBAL — without this, a plugin installed by
// another test file (bun's file order is platform-dependent) registers a
// simulator for bakery:registerOrder and outranks this file's fixture mocks.
beforeEach(() => {
  _resetActionSimulators();
});

class Demo extends Template {
  id = "demo";
  title = "Demo";
  type = "service";
  who = p.string({ title: "Who", required: true });

  build(): Step[] {
    return [
      // pure jsonata: builds { result: { greeting } } from the rendered `data`,
      // which also carries a literal array + nested object (recursion + preserve).
      {
        id: "compute",
        action: "roadiehq:utils:jsonata",
        input: {
          data: {
            who: nj((c) => c.parameters.who),
            list: [1, 2, 3],
            nested: { keep: true },
          },
          expression: jsonata<{ who: string }>((c) => ({
            greeting: `Hi ${c.who}`,
          })).jsonata,
        },
      },
      // boolean if = true → runs (mocked output).
      {
        id: "always",
        action: "debug:log",
        if: true,
        input: { msg: nj((c) => c.steps.compute.output.result.greeting) },
      },
      // boolean if = false → skipped.
      { id: "never", action: "debug:log", if: false, input: { msg: "x" } },
      // embedded (non-single) `${{ }}` if → renderToString path.
      {
        id: "embeddedif",
        action: "debug:log",
        if: raw`\${{ secrets.flag }}-tag`,
        input: {},
      },
      // full-`${{ }}` if → truthy/falsy on secrets.flag.
      {
        id: "maybe",
        action: "bakery:registerOrder",
        if: nj((c) => c.secrets.flag),
        input: { echo: nj((c) => c.parameters.who) },
      },
      // single full-expr `data: ${{ user }}` → object preserved as jsonata root.
      {
        id: "userfetch",
        action: "roadiehq:utils:jsonata",
        input: {
          data: nj((c) => c.user),
          expression: jsonata<{ id: string }>((c) => c.id).jsonata,
        },
      },
      // an `$assert` guard that throws when who !== "ok".
      {
        id: "guard",
        action: "roadiehq:utils:jsonata",
        input: {
          data: { x: nj((c) => c.parameters.who) },
          expression: jsonata<{ x: string }>((c) => {
            assert(c.x === "ok", "bad x");
            return { ok: true };
          }).jsonata,
        },
      },
    ];
  }

  output = {
    greeting: nj((c) => c.steps.compute.output.result.greeting),
    userId: nj((c) => c.steps.userfetch.output.result),
    mocked: nj((c) => c.steps.maybe.output.body),
    embedded: raw`pre-\${{ parameters.who }}-post`,
  };
}

const happyFixture = {
  parameters: { who: "ok" },
  secrets: { flag: "y" },
  user: { id: "u-1", extra: { a: 1 } },
  steps: {
    always: { output: { logged: true } },
    embeddedif: { output: {} },
    maybe: { output: { body: "ECHOED" } },
  },
};

describe("execute() — engine behaviour", () => {
  test("computes pure steps, mocks the rest, renders output", async () => {
    const { steps, output } = await execute(new Demo(), happyFixture);

    // pure jsonata computed for real:
    expect(steps.compute!.output).toEqual({ result: { greeting: "Hi ok" } });
    // literal array + nested object preserved through input rendering:
    expect((steps.compute!.input as any).data.list).toEqual([1, 2, 3]);
    expect((steps.compute!.input as any).data.nested).toEqual({ keep: true });
    // single `${{ user }}` preserved its object type as the jsonata root:
    expect((steps.userfetch!.input as any).data).toEqual({
      id: "u-1",
      extra: { a: 1 },
    });
    expect(steps.userfetch!.output).toEqual({ result: "u-1" });
    // guard passed (who === "ok"):
    expect(steps.guard!.output).toEqual({ result: { ok: true } });
    expect(steps.guard!.error).toBeUndefined();

    // if branches:
    expect(steps.never!.skipped).toBe(true); // boolean false
    expect(steps.always!.skipped).toBeUndefined(); // boolean true
    expect(steps.embeddedif!.skipped).toBeUndefined(); // "y-tag" truthy
    expect(steps.maybe!.skipped).toBeUndefined(); // full-expr truthy
    expect(steps.maybe!.output).toEqual({ body: "ECHOED" }); // mocked

    // output: full-expr refs + an embedded interpolation:
    expect(output).toEqual({
      greeting: "Hi ok",
      userId: "u-1",
      mocked: "ECHOED",
      embedded: "pre-ok-post",
    });
  });

  test("skips falsy-if steps; captures $assert throw; halted run has no output", async () => {
    const { steps, output } = await execute(new Demo(), {
      parameters: { who: "nope" },
      secrets: {},
      user: { id: "u-2" },
      steps: {},
    });

    // full-expr if falsy (no secrets.flag) → skipped, no output:
    expect(steps.maybe!.skipped).toBe(true);
    // non-pure step with no mock → output undefined:
    expect(steps.always!.output).toBeUndefined();
    // guard threw → error captured, output undefined:
    expect(steps.guard!.output).toBeUndefined();
    expect(steps.guard!.error).toContain("bad x");
    // guard is the LAST step, so nothing is downstream to mark `notReached`; but
    // its error HALTS the run, and a halted (failed) Backstage task has no
    // output — even the greeting computed by an earlier step is dropped, exactly
    // as real Backstage produces no `output` for a failed task.
    expect(output).toBeUndefined();
  });
});

// A gold YAML that is BEHAVIOURALLY equivalent to `Demo` (same ids/ifs/output,
// jsonata expressions written by hand in a different layout).
const goldEquivalent = `
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: demo
  title: Demo
spec:
  type: service
  parameters:
    properties: {}
  steps:
    - id: compute
      action: roadiehq:utils:jsonata
      input:
        data:
          who: \${{ parameters.who }}
          list: [1, 2, 3]
          nested:
            keep: true
        expression: '{ "greeting": "Hi " & who }'
    - id: always
      action: debug:log
      if: true
      input:
        msg: \${{ steps.compute.output.result.greeting }}
    - id: never
      action: debug:log
      if: false
      input:
        msg: x
    - id: embeddedif
      action: debug:log
      if: \${{ secrets.flag }}-tag
      input: {}
    - id: maybe
      action: bakery:registerOrder
      if: \${{ secrets.flag }}
      input:
        echo: \${{ parameters.who }}
    - id: userfetch
      action: roadiehq:utils:jsonata
      input:
        data: \${{ user }}
        expression: 'id'
    - id: guard
      action: roadiehq:utils:jsonata
      input:
        data:
          x: \${{ parameters.who }}
        expression: '($assert(x = "ok", "bad x"); { "ok": true })'
  output:
    greeting: \${{ steps.compute.output.result.greeting }}
    userId: \${{ steps.userfetch.output.result }}
    mocked: \${{ steps.maybe.output.body }}
    embedded: pre-\${{ parameters.who }}-post
`;

// Same, but the greeting differs ("Hello" vs "Hi") → behavioural divergence.
const goldDiverging = goldEquivalent.replace('"Hi " & who', '"Hello " & who');

describe("executeAgainstGold() — behavioural differential", () => {
  test("equivalent gold agrees on every step + output", async () => {
    const diff = await executeAgainstGold(new Demo(), goldEquivalent, happyFixture);
    expect(diff.ok).toBe(true);
    expect(diff.outputEqual).toBe(true);
    expect(Object.values(diff.stepsEqual).every(Boolean)).toBe(true);
    await expect(assertExecuteAgainstGold(new Demo(), goldEquivalent, happyFixture)).resolves.toBeUndefined();
  });

  test("agrees throw-for-throw when the guard fails on both sides", async () => {
    const diff = await executeAgainstGold(new Demo(), goldEquivalent, {
      parameters: { who: "nope" },
      secrets: { flag: "y" },
      user: { id: "u-2" },
      // an ARRAY mocked output → exercises the array branch of the deep-equal.
      steps: { always: { output: {} }, embeddedif: { output: {} }, maybe: { output: { body: ["x", "y"] } } },
    });
    expect(diff.stepsEqual.maybe).toBe(true);
    expect(diff.tdk.steps.guard!.error).toContain("bad x");
    expect(diff.stepsEqual.guard).toBe(true);
    expect(diff.ok).toBe(true);
  });

  test("diverging gold is detected; assert throws with detail", async () => {
    const diff = await executeAgainstGold(new Demo(), goldDiverging, happyFixture);
    expect(diff.ok).toBe(false);
    expect(diff.outputEqual).toBe(false);
    expect(diff.stepsEqual.compute).toBe(false);

    await expect(assertExecuteAgainstGold(new Demo(), goldDiverging, happyFixture)).rejects.toThrow(
      /diverged from gold standard/,
    );
  });
});

describe("execute() — BELT: a bad ${{ }} interpolation never crashes uncaught (#30)", () => {
  // compile now REJECTS a jsonata() object in a ${{ }} value, so a wrong-by-
  // construction `${{ <jsonata> }}` can only reach the engine via a hand-built
  // artifact (here the GOLD side of the differential). The Nunjucks renderer
  // throws on JSONata (`parseAggregate: expected comma after expression`); the
  // engine must catch it and surface it as the step's `error`, NOT let it escape.
  const Trivial = defineTemplate({
    id: "belt",
    title: "Belt",
    type: "service",
    parameters: { name: p.string({ required: true }) },
    steps: () => [step("noop", "debug:log", { input: {} })],
  });

  // A gold artifact whose step input holds a `${{ <jsonata> }}` (the `&` concat
  // operator is JSONata, not Nunjucks). Quoted so it stays a valid YAML scalar.
  const goldWithJsonataInput = [
    "apiVersion: scaffolder.backstage.io/v1beta3",
    "kind: Template",
    "metadata: { name: belt }",
    "spec:",
    "  type: service",
    "  parameters: { properties: {} }",
    "  steps:",
    "    - id: bad",
    "      action: http:backstage:request",
    "      input:",
    "        body: '${{ (\"hi \" & parameters.name) }}'",
    "  output: {}",
  ].join("\n");

  test("surfaces the Nunjucks parse failure as the step's error field", async () => {
    // Must resolve, not throw — the whole point of the belt.
    const diff = await executeAgainstGold(Trivial, goldWithJsonataInput, { parameters: { name: "x" } });
    const bad = diff.gold.steps.bad!;
    expect(bad.error).toBeDefined();
    expect(bad.error).toContain("parseAggregate");
    expect(bad.output).toBeUndefined();
  });

  test("also holds when the ${{ }} sits in the step `if`", async () => {
    const goldWithJsonataIf = [
      "apiVersion: scaffolder.backstage.io/v1beta3",
      "kind: Template",
      "metadata: { name: belt }",
      "spec:",
      "  type: service",
      "  parameters: { properties: {} }",
      "  steps:",
      "    - id: bad",
      "      action: debug:log",
      "      if: '${{ (parameters.a & parameters.b) }}'",
      "      input: {}",
      "  output: {}",
    ].join("\n");
    // A throw in `if` evaluation must not escape the run either.
    await expect(executeAgainstGold(Trivial, goldWithJsonataIf, { parameters: { name: "x" } })).resolves.toBeDefined();
  });
});

describe("execute() — HALT at the first failed step (Backstage fidelity)", () => {
  // Real Backstage stops the task at the first failed step: later steps never
  // run and the task produces NO output. TDK's `execute` mirrors that — the step
  // that errored keeps its `error` + rendered input, every step AFTER it becomes
  // `{ notReached: true }` with no rendered input, and the template `output` is
  // dropped. Only an `error` halts; a `skipped` (falsy `if:`) step does not.
  //
  // The bakery theme: an order pipeline whose price check ($assert) guards the
  // downstream "reserve oven" and "notify baker" steps.

  class OrderPipeline extends Template {
    id = "order-pipeline";
    title = "Order Pipeline";
    type = "service";
    cakePrice = p.number({ title: "Cake price", required: true });

    build(): Step[] {
      return [
        // A pure jsonata step whose $assert throws when the price is not > 0 —
        // the first (and only) failing step in this pipeline.
        {
          id: "check-price",
          action: "roadiehq:utils:jsonata",
          input: {
            data: { price: nj((c) => c.parameters.cakePrice) },
            expression: jsonata<{ price: number }>((c) => {
              assert(c.price > 0, "price must be positive");
              return { ok: true };
            }).jsonata,
          },
        },
        // Everything below is downstream of the failed guard — in real Backstage
        // these never run. Their inputs reference `check-price` on purpose: if
        // the engine (wrongly) rendered a `notReached` step's input against the
        // dead context, that would surface here.
        {
          id: "reserve-oven",
          action: "bakery:reserveOven",
          input: { forOrder: nj((c) => c.steps["check-price"].output.result.ok) },
        },
        {
          id: "notify-baker",
          action: "bakery:registerOrder",
          input: { msg: nj((c) => c.parameters.cakePrice) },
        },
      ];
    }

    // The output leans on a downstream step; a halted run must drop it entirely.
    output = {
      reserved: nj((c) => c.steps["reserve-oven"].output.body),
    };
  }

  test("a failing roadie-jsonata step halts: downstream steps notReached, no output", async () => {
    const { steps, output } = await execute(new OrderPipeline(), {
      // price 0 → the $assert guard throws.
      parameters: { cakePrice: 0 },
      steps: {
        // Mocks are supplied, yet the steps must STILL be `notReached` — a halt
        // means they never ran, so their mocked output is never applied.
        "reserve-oven": { output: { body: "RESERVED" } },
        "notify-baker": { output: { body: "NOTIFIED" } },
      },
    });

    // The failing step itself carries its error AND its rendered input, as today.
    expect(steps["check-price"]!.error).toContain("price must be positive");
    expect(steps["check-price"]!.output).toBeUndefined();
    expect((steps["check-price"]!.input as any).data).toEqual({ price: 0 });

    // Every downstream step is `notReached` — with NO rendered input (the halt
    // means we never render against the dead context) and no output, despite the
    // fixture mocks.
    expect(steps["reserve-oven"]!.notReached).toBe(true);
    expect(steps["reserve-oven"]!.input).toBeUndefined();
    expect(steps["reserve-oven"]!.output).toBeUndefined();
    expect(steps["notify-baker"]!.notReached).toBe(true);
    expect(steps["notify-baker"]!.input).toBeUndefined();
    expect(steps["notify-baker"]!.output).toBeUndefined();

    // A `notReached` step is NOT a `skipped` step — distinct rail states.
    expect(steps["reserve-oven"]!.skipped).toBeUndefined();

    // Halted (failed) task → no template output.
    expect(output).toBeUndefined();

    // All steps still present in the record, in declaration order.
    expect(Object.keys(steps)).toEqual(["check-price", "reserve-oven", "notify-baker"]);
  });

  test("the same pipeline SUCCEEDS (no halt) when the guard passes", async () => {
    const { steps, output } = await execute(new OrderPipeline(), {
      parameters: { cakePrice: 42 },
      steps: {
        "reserve-oven": { output: { body: "RESERVED" } },
        "notify-baker": { output: { body: "NOTIFIED" } },
      },
    });
    // Guard passed → no error, nothing `notReached`, downstream mocks applied,
    // and the output renders.
    expect(steps["check-price"]!.error).toBeUndefined();
    expect(steps["reserve-oven"]!.notReached).toBeUndefined();
    expect(steps["reserve-oven"]!.output).toEqual({ body: "RESERVED" });
    expect(steps["notify-baker"]!.output).toEqual({ body: "NOTIFIED" });
    expect(output).toEqual({ reserved: "RESERVED" });
  });

  test("a failing input render (BELT path) also halts the run", async () => {
    // A hand-built gold artifact whose FIRST step's input holds a `${{ <jsonata> }}`
    // (the `&` concat is JSONata, not Nunjucks) — the Nunjucks renderer throws,
    // the BELT catches it as the step's `error`, and that error must HALT the run
    // just like the roadie `expression:` path. A SECOND, well-formed bakery step
    // follows so we can prove it becomes `notReached`.
    const goldTwoSteps = [
      "apiVersion: scaffolder.backstage.io/v1beta3",
      "kind: Template",
      "metadata: { name: belt-halt }",
      "spec:",
      "  type: service",
      "  parameters: { properties: {} }",
      "  steps:",
      "    - id: bad-render",
      "      action: http:backstage:request",
      "      input:",
      "        body: '${{ (\"order \" & parameters.name) }}'",
      "    - id: after",
      "      action: bakery:registerOrder",
      "      input:",
      "        msg: hello",
      "  output:",
      "    done: '${{ steps.after.output.body }}'",
    ].join("\n");

    const Trivial = defineTemplate({
      id: "belt-halt",
      title: "Belt Halt",
      type: "service",
      parameters: { name: p.string({ required: true }) },
      steps: () => [step("noop", "debug:log", { input: {} })],
    });

    const diff = await executeAgainstGold(Trivial, goldTwoSteps, { parameters: { name: "x" } });
    const gold = diff.gold;

    // The failing render carries its error (and its RAW, unrendered input — the
    // BELT stores `step.input` untouched because rendering is what threw).
    expect(gold.steps["bad-render"]!.error).toBeDefined();
    expect(gold.steps["bad-render"]!.error).toContain("parseAggregate");
    expect(gold.steps["bad-render"]!.output).toBeUndefined();

    // The following step never runs: `notReached`, no input, no output — even
    // though its own input was perfectly valid.
    expect(gold.steps.after!.notReached).toBe(true);
    expect(gold.steps.after!.input).toBeUndefined();
    expect(gold.steps.after!.output).toBeUndefined();

    // Halted run → no output.
    expect(gold.output).toBeUndefined();

    // Both steps present, in order.
    expect(Object.keys(gold.steps)).toEqual(["bad-render", "after"]);
  });

  test("a SKIPPED (falsy `if:`) step does NOT halt — steps after it still run", async () => {
    // A skip is not a failure: the pipeline continues. Here the middle step is
    // skipped by a falsy `if:`; the step after it must run normally.
    class WithSkip extends Template {
      id = "with-skip";
      title = "With Skip";
      type = "service";
      params = {};
      build(): Step[] {
        return [
          { id: "first", action: "bakery:registerOrder", input: { msg: "one" } },
          // Skipped: boolean-false `if:` — NOT an error.
          { id: "middle", action: "bakery:registerOrder", if: false, input: { msg: "two" } },
          { id: "last", action: "bakery:registerOrder", input: { msg: "three" } },
        ];
      }
      output = { tail: nj((c) => c.steps.last.output.body) };
    }

    const { steps, output } = await execute(new WithSkip(), {
      parameters: {},
      steps: {
        first: { output: { body: "ONE" } },
        last: { output: { body: "THREE" } },
      },
    });

    // The middle step is `skipped`, NOT `notReached` — and NOT a halt.
    expect(steps.middle!.skipped).toBe(true);
    expect(steps.middle!.notReached).toBeUndefined();
    // The step AFTER the skip still ran (a skip does not halt the run)…
    expect(steps.last!.skipped).toBeUndefined();
    expect(steps.last!.notReached).toBeUndefined();
    expect(steps.last!.output).toEqual({ body: "THREE" });
    // …and the template output rendered normally.
    expect(output).toEqual({ tail: "THREE" });
  });

  test("a registered simulator that throws halts: execute() resolves, the step carries the error", async () => {
    // PARITY: a registered action simulator is just as capable of throwing as
    // the roadie jsonata evaluate() or the BELT input-render path — a broken
    // simulator is THIS step's failure, not a crash of the whole harness.
    // execute() must resolve (never reject) with the throw recorded as the
    // step's `error`, and halt exactly like the other two failure paths.
    registerActionSimulator("bakery:ovenCheck", () => {
      throw new Error("oven is cold");
    });

    class OvenPipeline extends Template {
      id = "oven-pipeline";
      title = "Oven Pipeline";
      type = "service";
      params = {};
      build(): Step[] {
        return [
          { id: "check-oven", action: "bakery:ovenCheck", input: {} },
          { id: "notify-baker", action: "bakery:registerOrder", input: { msg: "hi" } },
        ];
      }
      output = { done: nj((c) => c.steps["notify-baker"].output.body) };
    }

    const { steps, output } = await execute(new OvenPipeline(), {
      parameters: {},
      steps: { "notify-baker": { output: { body: "NOTIFIED" } } },
    });

    expect(steps["check-oven"]!.error).toContain("oven is cold");
    expect(steps["check-oven"]!.output).toBeUndefined();

    // Downstream step never ran, despite its fixture mock.
    expect(steps["notify-baker"]!.notReached).toBe(true);
    expect(steps["notify-baker"]!.input).toBeUndefined();
    expect(steps["notify-baker"]!.output).toBeUndefined();

    // Halted (failed) task → no template output.
    expect(output).toBeUndefined();
  });

  test("a throwing simulator on the LAST step: output still undefined, no crash", async () => {
    // No downstream step to mark `notReached` — this proves the halt still
    // suppresses `output` even when the throw is the final step, and that
    // execute() settles normally (does not reject).
    registerActionSimulator("bakery:ovenCheck", () => {
      throw new Error("oven is cold");
    });

    class OvenOnly extends Template {
      id = "oven-only";
      title = "Oven Only";
      type = "service";
      params = {};
      build(): Step[] {
        return [{ id: "check-oven", action: "bakery:ovenCheck", input: {} }];
      }
      output = { done: nj((c) => c.steps["check-oven"].output) };
    }

    const { steps, output } = await execute(new OvenOnly(), { parameters: {} });

    expect(steps["check-oven"]!.error).toContain("oven is cold");
    expect(steps["check-oven"]!.output).toBeUndefined();
    expect(output).toBeUndefined();
  });
});

describe("evalIf — Backstage isTruthy fidelity", () => {
  class IfDemo extends Template {
    id = "if-demo";
    title = "If Demo";
    type = "service";
    params = {};
    build(): Step[] {
      return [
        { id: "zero", action: "debug:log", if: raw`\${{ 0 }}` },
        { id: "strFalse", action: "debug:log", if: raw`\${{ parameters.s }}` },
        { id: "emptyArr", action: "debug:log", if: raw`\${{ parameters.list }}` },
        { id: "fullArr", action: "debug:log", if: raw`\${{ parameters.full }}` },
      ];
    }
  }

  test("full-expression if uses the native value: 0 falsy, 'false' string truthy, [] falsy", async () => {
    const { steps } = await execute(new IfDemo(), {
      parameters: { s: "false", list: [], full: [1] },
    });
    // ${{ 0 }} → native 0 → !!0 → skipped.
    expect(steps.zero!.skipped).toBe(true);
    // A param holding the STRING "false" is TRUTHY in Backstage (!!"false").
    expect(steps.strFalse!.skipped).toBeUndefined();
    // isTruthy special-cases arrays: [] is falsy…
    expect(steps.emptyArr!.skipped).toBe(true);
    // …and a non-empty array is truthy.
    expect(steps.fullArr!.skipped).toBeUndefined();
  });
});

describe("execute() — validateParams opt-in", () => {
  const cakeEnum = defineTemplate({
    id: "cake-validate",
    title: "Cake Validate",
    type: "service",
    parameters: {
      flavor: p.enum(["Vanilla", "Chocolate"], { required: true }),
      notes: p.string(),
    },
    steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor } })],
  });

  test("a renamed/unknown parameter fails loudly", async () => {
    await expect(
      // Bypass the phantom typing — validateParams exists exactly for fixtures the types can't see.
      execute(cakeEnum as any, { parameters: { flavor: "Vanilla", nots: "typo" } }, { validateParams: true }),
    ).rejects.toThrow(/\/nots is not a parameter of this template/);
  });

  test("an out-of-enum value fails loudly", async () => {
    await expect(
      // Bypass the phantom typing to reach the runtime validator.
      execute(cakeEnum as any, { parameters: { flavor: "Espresso" } }, { validateParams: true }),
    ).rejects.toThrow(/flavor must be equal to one of the allowed values/);
  });

  test("a missing required parameter fails loudly", async () => {
    await expect(execute(cakeEnum, { parameters: {} }, { validateParams: true })).rejects.toThrow(
      /must have required property 'flavor'/,
    );
  });

  test("a valid fixture passes and runs", async () => {
    const run = await execute(
      cakeEnum,
      { parameters: { flavor: "Vanilla" }, steps: { order: { output: {} } } },
      { validateParams: true },
    );
    expect(run.steps.order!.input).toEqual({ flavor: "Vanilla" });
  });

  test("without the opt-in, the same bad fixture still runs (back-compat)", async () => {
    // Bypass the phantom typing to prove the runtime default is permissive.
    const run = await execute(cakeEnum as any, { parameters: { flavor: "Espresso" } });
    expect(run.steps.order!.input).toEqual({ flavor: "Espresso" });
  });
});

describe("execute() — action simulators receive the target env", () => {
  test("ctx.env mirrors the execute target", async () => {
    const seen: string[] = [];
    defineAction({
      action: "bakery:envcheck",
      build: () => ({ id: "check", input: {} }),
      simulate: (_input, ctx) => {
        seen.push(ctx.env);
        return { env: ctx.env };
      },
    });
    class T extends Template {
      id = "env-check";
      title = "Env Check";
      type = "service";
      params = {};
      build(): Step[] {
        return [{ id: "check", action: "bakery:envcheck", input: {} }];
      }
    }
    const testRun = await execute(new T(), { parameters: {} });
    const prodRun = await execute(new T(), { parameters: {} }, { target: { env: "prod" } });
    expect(testRun.steps.check!.output).toEqual({ env: "test" });
    expect(prodRun.steps.check!.output).toEqual({ env: "prod" });
    expect(seen).toEqual(["test", "prod"]);
  });
});

// Issue #10: `registerActionSimulator` is process-global, keyed by action id —
// two templates sharing an action id share one registered simulator, so
// registering one for a pack's action helper can silently shift a DIFFERENT
// template's execute() results/snapshots. `ExecuteOptions.simulators` supplies
// a simulator scoped to ONE `execute()` call, taking precedence over the
// global registry (still beaten by an explicit fixture step mock — mirrors
// the existing mock-wins precedence: specific beats general, twice over).
describe("execute() — per-call simulators (issue #10)", () => {
  class OvenPipeline extends Template {
    id = "oven-pipeline-percall";
    title = "Oven Pipeline (per-call)";
    type = "service";
    params = {};
    build(): Step[] {
      return [{ id: "check-oven", action: "bakery:ovenCheck", input: {} }];
    }
  }

  test("a per-call simulator overrides the global registry for the same action id", async () => {
    registerActionSimulator("bakery:ovenCheck", () => ({ source: "global" }));

    const { steps } = await execute(
      new OvenPipeline(),
      { parameters: {} },
      { simulators: { "bakery:ovenCheck": () => ({ source: "per-call" }) } },
    );

    expect(steps["check-oven"]!.output).toEqual({ source: "per-call" });
  });

  test("a per-call simulator works with no global simulator registered for that action", async () => {
    // No registerActionSimulator call at all for "bakery:ovenCheck" — the
    // process-global registry is empty for this action id.
    const { steps } = await execute(
      new OvenPipeline(),
      { parameters: {} },
      { simulators: { "bakery:ovenCheck": () => ({ source: "per-call-only" }) } },
    );

    expect(steps["check-oven"]!.output).toEqual({ source: "per-call-only" });
  });

  test("an explicit fixture step mock still beats a per-call simulator", async () => {
    registerActionSimulator("bakery:ovenCheck", () => ({ source: "global" }));

    const { steps } = await execute(
      new OvenPipeline(),
      { parameters: {}, steps: { "check-oven": { output: { source: "fixture-mock" } } } },
      { simulators: { "bakery:ovenCheck": () => ({ source: "per-call" }) } },
    );

    expect(steps["check-oven"]!.output).toEqual({ source: "fixture-mock" });
  });

  test("an action absent from the per-call map falls through to the global registry", async () => {
    registerActionSimulator("bakery:ovenCheck", () => ({ source: "global" }));

    // `simulators` is supplied but keys a DIFFERENT action — "bakery:ovenCheck"
    // itself has no per-call entry, so it must fall through to the registry.
    const { steps } = await execute(
      new OvenPipeline(),
      { parameters: {} },
      { simulators: { "bakery:someOtherAction": () => ({ source: "unrelated" }) } },
    );

    expect(steps["check-oven"]!.output).toEqual({ source: "global" });
  });
});

// ---------------------------------------------------------------------------
// TYPE-INFERENCE PROOF — never executed; verified by `tsc --noEmit` (typecheck).
// `execute` infers the fixture's `parameters` from a defineTemplate result's
// `__tdkParams` phantom; a wrong-typed or unknown parameter is a type error.
// A class template stays loose (Record<string, unknown>).
// ---------------------------------------------------------------------------

const typedProof = defineTemplate({
  id: "typed-proof",
  title: "Typed Proof",
  type: "service",
  parameters: { flavor: p.enum(["Vanilla", "Chocolate"], { required: true }) },
  steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor } })],
});

async function _executeFixtureTypeProof(): Promise<void> {
  await execute(typedProof, { parameters: { flavor: "Vanilla" } });
  // @ts-expect-error — 42 is not assignable to the flavor enum
  await execute(typedProof, { parameters: { flavor: 42 } });
  // @ts-expect-error — "Espresso" is not a flavor of this template
  await execute(typedProof, { parameters: { flavor: "Espresso" } });
  // @ts-expect-error — `flavr` is not a parameter (renamed params fail the types)
  await execute(typedProof, { parameters: { flavr: "Vanilla" } });
  // A class template (no phantom) still accepts a loose record.
  await execute(new Demo(), { parameters: { anything: "goes" } });
}
void _executeFixtureTypeProof;

describe("execute() — target option", () => {
  test("accepts an explicit target (env-agnostic template)", async () => {
    const { output } = await execute(new Demo(), happyFixture, {
      target: { env: "prod", outDir: "" },
    });
    expect((output as any).greeting).toBe("Hi ok");
  });
});
