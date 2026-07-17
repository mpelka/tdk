// Tests for the Custom Cake Order Wizard.
//
// The discipline: `gold-standard.yaml` was hand-written from the behavioural spec
// BEFORE the template was compiled. These tests assert the COMPILED entity agrees
// with that gold — structurally (page + dependency shapes) and, where the gold is
// executable, behaviourally (`assertExecuteAgainstGold`) — plus schema-validate
// BOTH sides. Agreement is value-based, never byte-based (the gold's hand
// formatting differs from the pretty-printer, and that is healthy).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertExecuteAgainstGold, assertValid, compile, type PageObject, validate } from "@tdk/core";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { CustomCakeOrderWizard } from "./template.ts";

const nonprod = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");

describe("custom-cake-order-wizard — structure", () => {
  const { object } = compile(CustomCakeOrderWizard, nonprod);
  const pages = object.spec.parameters as PageObject[];

  test("compiles to a 4-page wizard with the expected page titles", () => {
    expect(object.metadata.name).toBe("custom-cake-order-wizard");
    expect(pages.map((p) => p.title)).toEqual(["Order Type", "Packaging & Speed", "Baker Notes", "Delivery"]);
  });

  test("invariant (a): the wedding branch nests topper → topperText INSIDE it (not flattened)", () => {
    // Page 1's ONLY top-level dependency controller is `orderType` — `topper` must
    // NOT appear as a page-level sibling (that would be the flattened shape).
    const page1 = pages[0]!;
    expect(Object.keys(page1.dependencies ?? {})).toEqual(["orderType"]);

    const orderType = page1.dependencies!.orderType as { oneOf: Array<Record<string, unknown>> };
    const weddingBranch = orderType.oneOf.find(
      (b) =>
        ((b.properties as Record<string, { const?: unknown }>).orderType as { const?: unknown }).const === "wedding",
    ) as { properties: Record<string, unknown>; dependencies?: Record<string, unknown> };

    // The wedding branch reveals `tiers` + `topper`...
    expect(weddingBranch.properties).toHaveProperty("tiers");
    expect(weddingBranch.properties).toHaveProperty("topper");
    // ...and carries a NESTED `topper` dependency revealing `topperText`.
    const nested = weddingBranch.dependencies!.topper as { oneOf: Array<Record<string, unknown>> };
    const topperOn = nested.oneOf.find(
      (b) => ((b.properties as Record<string, { const?: unknown }>).topper as { const?: unknown }).const === true,
    ) as { properties: Record<string, unknown> };
    expect(topperOn.properties).toHaveProperty("topperText");
  });

  test("invariant (c): the raw `rush` dependency survives VERBATIM next to the compiled dep.when", () => {
    const page2 = pages[1]!;
    // Both controllers present on the same page: dep.when(packaging) + raw(rush).
    expect(Object.keys(page2.dependencies ?? {}).sort()).toEqual(["packaging", "rush"]);
    // The raw `rush` entry is emitted exactly as authored (a title TDK never sets
    // itself on a passthrough): proves it wasn't re-shaped.
    const rush = page2.dependencies!.rush as {
      oneOf: Array<{ properties?: Record<string, unknown> }>;
    };
    const rushOn = rush.oneOf[1]!.properties!;
    expect(rushOn.rushJustification).toEqual({ type: "string", title: "Why is this order urgent?" });
  });

  test("page 4 (composed form): the `.showWhen(...)` method synthesises the SAME tree shape", () => {
    // Authored with NO dep.*, page 4 must compile to two independent dependency
    // trees — the composed surface is pure sugar over the same synthesiser.
    const page4 = pages[3]!;
    expect(Object.keys(page4.dependencies ?? {}).sort()).toEqual(["contactPref", "deliveryMethod"]);

    // The all(...) AND-chain nests: courier branch → courierSpeed dep → express
    // branch reveals `insurance` (two levels deep, like page 1's topper chain).
    const delivery = page4.dependencies!.deliveryMethod as { oneOf: Array<Record<string, unknown>> };
    const courier = delivery.oneOf.find(
      (b) =>
        ((b.properties as Record<string, { const?: unknown }>).deliveryMethod as { const?: unknown }).const ===
        "courier",
    ) as { properties: Record<string, unknown>; dependencies?: Record<string, unknown> };
    expect(courier.properties).toHaveProperty("courierSpeed");
    const speed = courier.dependencies!.courierSpeed as { oneOf: Array<Record<string, unknown>> };
    const express = speed.oneOf.find(
      (b) =>
        ((b.properties as Record<string, { const?: unknown }>).courierSpeed as { const?: unknown }).const === "express",
    ) as { properties: Record<string, unknown> };
    expect(express.properties).toHaveProperty("insurance");

    // any(...) and .in([...]) both key off `contactPref`, so they GROUP: `mobile`
    // appears in the sms + call branches, `notifyEmail` in the email + sms branches.
    const contact = page4.dependencies!.contactPref as { oneOf: Array<Record<string, unknown>> };
    const byValue = (v: string) =>
      contact.oneOf.find(
        (b) => ((b.properties as Record<string, { const?: unknown }>).contactPref as { const?: unknown }).const === v,
      )!.properties as Record<string, unknown>;
    expect(byValue("sms")).toHaveProperty("mobile");
    expect(byValue("sms")).toHaveProperty("notifyEmail");
    expect(byValue("email")).toHaveProperty("notifyEmail");
    expect(byValue("email")).not.toHaveProperty("mobile");
    expect(byValue("call")).toHaveProperty("mobile");
    expect(byValue("call")).not.toHaveProperty("notifyEmail");
  });

  test("the single step is the debug:log order logger", () => {
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "log-order", action: "debug:log" },
    ]);
  });
});

describe("custom-cake-order-wizard — schema validity (both sides)", () => {
  test("the COMPILED entity is schema-valid", async () => {
    const { object } = compile(CustomCakeOrderWizard, nonprod);
    await assertValid(object);
  });

  test("the HAND-WRITTEN gold is schema-valid", async () => {
    const goldEntity = (await import("yaml")).parse(gold);
    const { valid, errors } = await validate(goldEntity);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("custom-cake-order-wizard — whole-run agreement vs the gold", () => {
  // Invariant (b) is pinned here too: the `standard` scenario supplies no wedding
  // fields, and the run output/steps match the gold with none appearing.
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      await assertExecuteAgainstGold(CustomCakeOrderWizard, gold, scenario.fixture);
    });
  }

  test("invariant (b): a standard order renders no wedding field in the run", async () => {
    // The step message only ever names orderType; a standard run must not leak a
    // tiers/topper/topperText value into the resolved input.
    const { execute } = await import("@tdk/core");
    const run = await execute(CustomCakeOrderWizard, {
      parameters: { orderType: "standard", contactEmail: "sam@bakery.example" },
      steps: { "log-order": { output: {} } },
    });
    const input = run.steps["log-order"]!.input as { message: string };
    expect(input.message).toBe("Order type: standard");
    expect(input.message).not.toContain("tier");
    expect(input.message).not.toContain("topper");
  });
});
