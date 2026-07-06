// The STATEMENT-LAYER deliverable, end-to-end, on a synthetic fixture.
//
// `cakeOrderSummary` (a block-bodied `jsonata(...)` authored in TS) is exercised:
//   1. its compiled JSONata is asserted to be procedural (block bindings,
//      `$assert`, `$append`, membership `in`),
//   2. differential A — JS oracle vs compiled JSONata,
//   3. differential B — compiled JSONata vs a reference JSONata string
//      (`assertDifferentialJsonata` / `differentialJsonata`),
//   4. throw-for-throw behaviour spot-checks via the JS oracle.
//
// Fixtures cover every ternary branch plus one per `assert` guard, so "both
// threw the same message" is a first-class differential outcome.

import { describe, expect, test } from "bun:test";
import { assertDifferential, assertDifferentialJsonata, differentialJsonata } from "../index.ts";
import { cakeOrderSummary as benchmark, type CakeOrderCtx } from "./cake-order.ts";

// A plain 8-inch order; the other fixtures derive from this base.
const base: CakeOrderCtx = {
  size: "8 inch",
  flavour: "Vanilla",
  customerName: "Ada",
  membership: "",
  occasion: "",
  giftBox: "No",
  giftMessage: "",
  rushOrder: "No",
  rushReason: "",
  decorations: "Sprinkles",
};

const fixtures: Record<string, CakeOrderCtx> = {
  normal: base,
  sixInch: { ...base, size: "6 inch" }, // basePrice 20
  tenInch: { ...base, size: "10 inch" }, // membership-`in` branch
  sheet: { ...base, size: "Sheet" }, // basePrice 60
  unknownSize: { ...base, size: "Cupcake" }, // fallback basePrice 0
  member: { ...base, membership: "Member" }, // discount line
  occasion: { ...base, occasion: "Birthday" }, // optional summary segment
  rush: { ...base, rushOrder: "Yes", rushReason: "Wedding tomorrow" },
  giftBox: { ...base, giftBox: "Yes", giftMessage: "Congrats" },
  // One fixture per `assert` failure.
  failName: { ...base, customerName: "" },
  failRush: { ...base, rushOrder: "Yes", rushReason: "" },
  failGift: { ...base, giftBox: "Yes", giftMessage: "" },
};
const allFixtures = Object.values(fixtures);

describe("cake-order benchmark — compiles to procedural JSONata", () => {
  test("the statement layer emits bindings, $assert, $append, and membership", () => {
    const j = benchmark.jsonata;
    expect(j).toContain("$assert(");
    expect(j).toContain(":="); // variable bindings
    expect(j).toContain("$append(");
    expect(j).toContain('in ["8 inch", "10 inch"]'); // array-literal membership
    expect(j.trim().startsWith("(")).toBe(true); // a JSONata block
  });
});

describe("differential A: JS oracle vs compiled JSONata", () => {
  test("agrees on every fixture (including the assert throws)", async () => {
    await expect(assertDifferential(benchmark, allFixtures)).resolves.toBeUndefined();
  });
});

describe("differential B: compiled JSONata vs a reference JSONata", () => {
  test("reproduces a reference expression value-for-value / throw-for-throw", async () => {
    // The compiled JSONata is its own faithful reference: this proves the
    // value-/throw-equivalence path of the `*Jsonata` harness over every fixture.
    await expect(assertDifferentialJsonata(benchmark, benchmark.jsonata, allFixtures)).resolves.toBeUndefined();
  });

  test("reports a mismatch against a diverging reference", async () => {
    const result = await differentialJsonata(benchmark, '"always-this"', [fixtures.normal!]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([0]);
  });
});

describe("cake-order behaviour spot-checks (via the JS oracle)", () => {
  test("normal order: base + delivery line, price from the membership `in` branch", () => {
    const out = benchmark.fn(fixtures.normal!) as any;
    expect(out.basePrice).toBe(35);
    expect(out.lineItems.map((l: any) => l.label)).toEqual(["Base", "Delivery"]);
  });

  test("member order inserts the discount line", () => {
    const out = benchmark.fn(fixtures.member!) as any;
    expect(out.lineItems.map((l: any) => l.label)).toEqual(["Base", "Member discount", "Delivery"]);
  });

  test("rush order appends the surcharge line", () => {
    const out = benchmark.fn(fixtures.rush!) as any;
    expect(out.lineItems.map((l: any) => l.label)).toEqual(["Base", "Delivery", "Rush surcharge"]);
  });

  test("the optional occasion segment only appears when set", () => {
    expect((benchmark.fn(fixtures.normal!) as any).summary).not.toContain("Occasion:");
    expect((benchmark.fn(fixtures.occasion!) as any).summary).toContain("Occasion: Birthday");
  });

  test("an unknown size falls through to the zero base price", () => {
    expect((benchmark.fn(fixtures.unknownSize!) as any).basePrice).toBe(0);
  });

  test("each guard throws its exact message", () => {
    expect(() => benchmark.fn(fixtures.failName!)).toThrow("A customer name is required.");
    expect(() => benchmark.fn(fixtures.failRush!)).toThrow("A reason is required for a rush order.");
    expect(() => benchmark.fn(fixtures.failGift!)).toThrow("A gift message is required when a gift box is selected.");
  });
});
