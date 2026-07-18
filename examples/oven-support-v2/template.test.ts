// Tests for the Oven Support Request (v2) — the AUTHORING-V2 surface, end to end.
//
// The v2 shape is the star, so the tests cover it whole:
//   - STRUCTURE & PLANNING: the effect + its three derives compile to the planned
//     step order (derives first, then the effect), with auto-wired handle
//     references and handle-based output.
//   - ui:order INFERENCE: each page emits `ui:order` for its base fields in source
//     order (conditional fields excluded — they live in `dependencies`).
//   - DIFFERENTIAL: each derive's transpiled JSONata agrees with the gold's
//     hand-written JSONata (value + throw), via the SAME harness `jsonata()` uses.
//   - EFFECT MOCKING: the effect is a non-jsonata action, so an explicit fixture
//     mock WINS over the pack's registered simulator (contrast: a derive is always
//     computed for real, never mockable this way).
//   - WHOLE-RUN: `assertExecuteAgainstGold` per scenario, and schema validity of
//     both the compiled entity and the hand-written gold.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertDifferentialJsonata,
  assertExecuteAgainstGold,
  assertValid,
  compile,
  execute,
  getDeriveExpr,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { OvenSupportRequestV2, problemSummary, slaHours, ticketTitle } from "./template.ts";

const target = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");

/** Pull one gold step's JSONata `expression` by step id (trimmed). */
function goldExpr(id: string): string {
  const steps = parse(gold).spec.steps as Array<{ id: string; input?: { expression?: string } }>;
  const found = steps.find((s) => s.id === id);
  if (!found?.input?.expression) throw new Error(`gold has no expression for step "${id}"`);
  return found.input.expression.trim();
}

describe("oven-support-v2 — structure & planning", () => {
  const { object, diagnostics } = compile(OvenSupportRequestV2, target);

  test("the effect and its three derives plan in order (derives, then the effect)", () => {
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "ticket-title", action: "roadiehq:utils:jsonata" },
      { id: "sla-hours", action: "roadiehq:utils:jsonata" },
      { id: "problem-summary", action: "roadiehq:utils:jsonata" },
      { id: "open-oven-ticket", action: "bakery:raise-ticket" },
    ]);
  });

  test("no unreachable-derive diagnostic — every derive is consumed by the effect", () => {
    expect(diagnostics).toBeUndefined();
  });

  test("the effect step consumes the derived values by auto-wired handle", () => {
    const input = object.spec.steps.find((s) => s.id === "open-oven-ticket")!.input as Record<string, string>;
    expect(input.title).toBe("${{ steps['ticket-title'].output.result }}");
    expect(input.slaHours).toBe("${{ steps['sla-hours'].output.result }}");
    expect(input.summary).toBe("${{ steps['problem-summary'].output.result }}");
    // A conditional field with a default, via `.ref.orElse("")` at module scope.
    expect(input.urgentReason).toBe('${{ parameters.urgentReason | default("") }}');
  });

  test("output reads the effect's output BY HANDLE (sub-refs into .body)", () => {
    expect(object.spec.output).toEqual({
      ticketUrl: "${{ steps['open-oven-ticket'].output.body.url }}",
      ticketId: "${{ steps['open-oven-ticket'].output.body.id }}",
    });
  });
});

describe("oven-support-v2 — ui:order is inferred from each page's source order", () => {
  const { object } = compile(OvenSupportRequestV2, target);
  const pages = object.spec.parameters as Array<{ title: string; "ui:order"?: string[] }>;

  test("each page's ui:order names its BASE fields in source order (conditionals excluded)", () => {
    expect(pages.map((p) => ({ title: p.title, order: p["ui:order"] }))).toEqual([
      { title: "Oven and site", order: ["bakeryCode", "ovenId", "ovenType"] },
      // otherDetail / urgentReason are conditional → in `dependencies`, not ui:order.
      { title: "The problem", order: ["severity", "problemArea"] },
      { title: "Contact", order: ["contactEmail"] },
    ]);
  });
});

describe("oven-support-v2 — the derived expressions (differential vs the gold)", () => {
  test("ticket-title: transpiled JSONata == the gold's hand-written JSONata", async () => {
    await assertDifferentialJsonata(getDeriveExpr(ticketTitle), goldExpr("ticket-title"), [
      { bakeryCode: "BK1", ovenId: "OV-1", severity: "urgent" },
      { bakeryCode: "BK2", ovenId: "OV-2", severity: "normal" },
      { bakeryCode: "BK3", ovenId: "OV-3", severity: "low" },
    ]);
  });

  test("sla-hours: transpiled JSONata == the gold's hand-written JSONata", async () => {
    await assertDifferentialJsonata(getDeriveExpr(slaHours), goldExpr("sla-hours"), [
      { severity: "urgent" },
      { severity: "normal" },
      { severity: "low" },
    ]);
  });

  test("problem-summary (conditional): agrees whether otherDetail is present or absent", async () => {
    await assertDifferentialJsonata(getDeriveExpr(problemSummary), goldExpr("problem-summary"), [
      { problemArea: "other", otherDetail: "Door seal warped" }, // present → verbatim
      { problemArea: "other" }, // absent → "unspecified"
      { problemArea: "heating" }, // not "other" → the area itself
    ]);
  });
});

describe("oven-support-v2 — effect mocking (mock wins over the pack simulator)", () => {
  const base = {
    bakeryCode: "BK1",
    ovenId: "OV-9",
    ovenType: "deck",
    severity: "normal",
    problemArea: "heating",
    contactEmail: "x@y.example",
  } as const;

  test("an explicit fixture mock for the effect step wins", async () => {
    const { steps, output } = await execute(OvenSupportRequestV2, {
      parameters: { ...base },
      steps: { "open-oven-ticket": { output: { body: { id: "MOCK-1", url: "https://mock/1" } } } },
    });
    expect(steps["open-oven-ticket"]!.output).toEqual({ body: { id: "MOCK-1", url: "https://mock/1" } });
    expect(output).toEqual({ ticketUrl: "https://mock/1", ticketId: "MOCK-1" });
  });

  test("with NO mock, the pack's registered simulator computes the receipt from input", async () => {
    const { steps, output } = await execute(OvenSupportRequestV2, { parameters: { ...base } });
    // simulateRaiseTicket keys the id on the rendered `oven` input.
    expect(steps["open-oven-ticket"]!.output).toEqual({
      body: { id: "TCK-OV-9", url: "https://catalog.example/tickets/TCK-OV-9" },
    });
    expect(output).toEqual({ ticketUrl: "https://catalog.example/tickets/TCK-OV-9", ticketId: "TCK-OV-9" });
  });
});

describe("oven-support-v2 — schema validity (both sides)", () => {
  test("the COMPILED entity is schema-valid", async () => {
    await assertValid(compile(OvenSupportRequestV2, target).object);
  });

  test("the HAND-WRITTEN gold is schema-valid", async () => {
    const { valid, errors } = await validate(parse(gold));
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("oven-support-v2 — whole-run agreement vs the gold", () => {
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      await assertExecuteAgainstGold(OvenSupportRequestV2, gold, scenario.fixture);
    });
  }
});
