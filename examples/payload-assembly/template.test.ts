// Tests for the Order Ticket Builder.
//
// The block-bodied `jsonata` expression is the star, so the tests lean on the two
// differential harnesses:
//   - `assertDifferentialJsonata` — the COMPILED expression vs the gold's HAND-
//     WRITTEN JSONata, value-for-value AND throw-for-throw across fixtures (incl.
//     the $assert edge). Proves the transpiler reproduces the expert-authored
//     expression exactly.
//   - `assertDifferential` — the compiled expression vs the TS oracle (the arrow
//     re-run in JS), with `nanIsMissing` for the documented `parseInt` edge.
// Plus `assertExecuteAgainstGold` for whole-run agreement and schema validation of
// BOTH the compiled entity and the hand-written gold.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertDifferential,
  assertDifferentialJsonata,
  assertExecuteAgainstGold,
  assertValid,
  compile,
  execute,
  jsonata,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { OrderTicketBuilder } from "./template.ts";
import { type TicketCtx, ticketPayload } from "./ticket.ts";

const nonprod = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");
const goldExpression = (parse(gold).spec.steps[0].input.expression as string).trim();

// Expression fixtures (the roadie step's `data` root) — three normal + a throwing
// edge (empty customerName aborts via $assert). Includes a two-item order and the
// three discount-code kinds (real prefix / no prefix / free text).
const exprFixtures: TicketCtx[] = [
  {
    customerName: "Alice",
    items: [
      { sku: "CAKE-1", qty: 2, options: ["gluten-free", "vanilla"], unitPrice: 10 },
      { sku: "TOPPER-1", qty: 1, options: [], unitPrice: 4 },
    ],
    priority: "high",
    discountCode: "15OFF",
  },
  {
    customerName: "Bob",
    items: [{ sku: "CAKE-2", qty: 1, options: ["chocolate"], unitPrice: 8 }],
    priority: "normal",
    discountCode: "SAVE15x",
  },
  {
    customerName: "Cleo",
    items: [{ sku: "CAKE-3", qty: 3, options: ["red-velvet"] }],
    priority: "low",
    discountCode: "none",
  },
  // Signed / whitespace-prefixed codes: JS parseInt("+12off") is 12, and a naive
  // $number over the raw match ("+12", "  34") THROWS in JSONata — the exact
  // weak-oracle gap the adversarial verification found in the first gold. Keep
  // both here so the differential harness guards the edge permanently.
  {
    customerName: "Dana",
    items: [{ sku: "CAKE-4", qty: 1, options: ["lemon"], unitPrice: 6 }],
    priority: "normal",
    discountCode: "+12off",
  },
  {
    customerName: "Eryk",
    items: [{ sku: "CAKE-5", qty: 2, options: [], unitPrice: 5 }],
    priority: "low",
    discountCode: "  34xx",
  },
  // Throwing edge: the $assert guard aborts (customerName is empty).
  { customerName: "", items: [], priority: "low", discountCode: "" },
];

describe("order-ticket-builder — structure", () => {
  const { object } = compile(OrderTicketBuilder, nonprod);

  test("two steps: the roadie jsonata builder then the debug:log", () => {
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "build-ticket", action: "roadiehq:utils:jsonata" },
      { id: "log-ticket", action: "debug:log" },
    ]);
  });

  test("roadie step: `data` fields are ${{ }} templates, `expression` is JSONata", () => {
    const input = object.spec.steps[0]!.input as { data: Record<string, string>; expression: string };
    // Every `data` field is a Scaffolder template (from nj) — NOT the JSONata.
    for (const v of Object.values(input.data)) expect(v).toMatch(/^\$\{\{.*\}\}$/);
    // The expression is the JSONata block (a `$assert`/`:=` statement layer), never
    // a `${{ }}` template.
    expect(input.expression).toContain("$assert");
    expect(input.expression).not.toContain("${{");
  });

  test("the log step consumes the previous step's .output.result", () => {
    const input = object.spec.steps[1]!.input as { message: string };
    expect(input.message).toContain('steps["build-ticket"].output.result.summary');
  });
});

describe("order-ticket-builder — schema validity (both sides)", () => {
  test("the COMPILED entity is schema-valid", async () => {
    const { object } = compile(OrderTicketBuilder, nonprod);
    await assertValid(object);
  });

  test("the HAND-WRITTEN gold is schema-valid", async () => {
    const { valid, errors } = await validate(parse(gold));
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("order-ticket-builder — the ticket expression (differential)", () => {
  test("compiled JSONata == the gold's hand-written JSONata (value + throw)", async () => {
    // The strong oracle: the compiled expression vs the expert's hand-written
    // JSONata, across ALL fixtures. Invariant (c): the throwing $assert fixture
    // agrees throw-for-throw. This is where the singleton-collapse subtlety was
    // caught (the naive gold `items.{…}` diverged from the array-safe `.map`).
    await assertDifferentialJsonata(ticketPayload, goldExpression, exprFixtures);
  });

  test("compiled JSONata == the TS oracle where the result has no nested NaN", async () => {
    // Invariant (a): `x || 0` yields the VALUE. Invariant (b): the nested-lambda
    // reduce-to-scalar (join) agrees with JS. Run the WHOLE-object oracle only on
    // fixtures whose discountPct is a real number — a NON-numeric code leaves the
    // TS oracle with a NESTED `NaN` (parseInt divergence), which the object-level
    // harness can't fold to missing; that edge is pinned in isolation below.
    const numericDiscount = exprFixtures.filter((f) => /^\s*[-+]?[0-9]/.test(f.discountCode ?? ""));
    await assertDifferential(ticketPayload, numericDiscount);
  });

  test("the parseInt(discountCode) shim — isolated, with nanIsMissing", async () => {
    // Isolate the discount shim so the parseInt result IS the top-level value,
    // where `nanIsMissing` encodes the documented agreement: a numeric PREFIX
    // parses ("15OFF" → 15), no prefix is MISSING (JS → NaN), matching the shim.
    // biome-ignore lint/correctness/useParseIntRadix: the TDK jsonata transpiler rejects parseInt's radix argument (see docs/expression-support.md)
    const discountShim = jsonata<{ discountCode: string }>((c) => parseInt(c.discountCode));
    await assertDifferential(
      discountShim,
      [
        { discountCode: "15OFF" }, // → 15 (numeric prefix)
        { discountCode: "SAVE15x" }, // → missing (no LEADING prefix)
        { discountCode: "none" }, // → missing (free text)
        { discountCode: "42" }, // → 42
      ],
      { nanIsMissing: true },
    );
  });
});

describe("order-ticket-builder — whole-run agreement vs the gold", () => {
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      await assertExecuteAgainstGold(OrderTicketBuilder, gold, scenario.fixture);
    });
  }

  test("invariant (a): `unitPrice || 0` renders the VALUE (a present price passes through)", async () => {
    const run = await execute(OrderTicketBuilder, scenarios[0]!.fixture);
    const result = (
      run.steps["build-ticket"]!.output as { result: { lineItems: Array<{ unitPrice: unknown }>; total: number } }
    ).result;
    // A present price (10) flows through, not `true`; a fold gives a numeric total.
    expect(result.lineItems[0]!.unitPrice).toBe(10);
    expect(result.total).toBe(20); // baseFee 5 + rushFee 15 (high priority)
  });

  test("invariant (c): the throwing $assert HALTS the run (empty customer)", async () => {
    const run = await execute(OrderTicketBuilder, {
      parameters: { customerName: "", items: [], priority: "low" },
    });
    // A jsonata step whose expression throws records the error and no output…
    expect(run.steps["build-ticket"]!.error).toContain("customerName is required");
    expect(run.steps["build-ticket"]!.output).toBeUndefined();
    // …and, like real Backstage, the failure HALTS the task: the downstream
    // `log-ticket` never runs (it is `notReached`, with no rendered input), and a
    // failed task has no template output.
    expect(run.steps["log-ticket"]!.notReached).toBe(true);
    expect(run.steps["log-ticket"]!.input).toBeUndefined();
    expect(run.steps["log-ticket"]!.output).toBeUndefined();
    expect(run.output).toBeUndefined();
  });
});
