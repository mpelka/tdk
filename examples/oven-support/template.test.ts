// Tests for the Oven Support Request — the `derive` (dataflow) example.
//
// The derived values are the star, so the tests cover the whole phase-3a surface:
//   - STRUCTURE: the reachable derives compile to `roadiehq:utils:jsonata` steps,
//     topologically interleaved with the two manual steps (the SSA chain
//     oven-lookup → oven-context → register), with auto-wired references.
//   - BYTE-EQUIVALENCE: the derive-authored template compiles to the IDENTICAL YAML
//     as a twin whose roadie steps + references are hand-written.
//   - DIFFERENTIAL: each derive's transpiled expression agrees with the gold's
//     hand-written JSONata (value + throw), via the SAME harness `jsonata()` uses.
//   - WHOLE-RUN: `assertExecuteAgainstGold` per scenario, and schema validity of
//     both the compiled entity and the hand-written gold.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  _resetDeriveRegistry,
  assertDifferentialJsonata,
  assertExecuteAgainstGold,
  assertValid,
  compile,
  defineTemplate,
  getDeriveExpr,
  type NjContext,
  nj,
  page,
  raw,
  step,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { scenarios } from "./__fixtures__/scenarios.ts";
import {
  auditTag,
  bakeryCode,
  OvenSupportRequest,
  otherDetail,
  ovenContext,
  ovenId,
  problemArea,
  problemSummary,
  severity,
  slaHours,
  ticketTitle,
} from "./template.ts";

const nonprod = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");

// REGISTRY HYGIENE: this template's `oven-context` derive has ONLY nj-marker
// inputs (no params), so it is "vacuously attributable" to EVERY template — left
// registered after this file, it would surface as an unreachable-derive
// diagnostic in ANY later-loaded file's compile (the process-wide registry +
// platform-dependent test-file order; the Linux CI failure on 5a492e5). Leave
// the registry clean for later-loaded files.
afterAll(() => {
  _resetDeriveRegistry();
});

/** Pull one gold step's JSONata `expression` by step id (trimmed). */
function goldExpr(id: string): string {
  const steps = parse(gold).spec.steps as Array<{ id: string; input?: { expression?: string } }>;
  const found = steps.find((s) => s.id === id);
  if (!found?.input?.expression) throw new Error(`gold has no expression for step "${id}"`);
  return found.input.expression.trim();
}

describe("oven-support — structure & planning", () => {
  // Isolate from foreign registry state BEFORE compiling — the no-diagnostics
  // assertion below is about THIS template's derives only (see the hygiene note
  // at the top of the file).
  _resetDeriveRegistry();
  const { object, diagnostics } = compile(OvenSupportRequest, nonprod);

  test("reachable derives interleave with manual steps in topological order", () => {
    // Five derived steps + two manual, SSA-ordered: oven-lookup precedes its
    // consumer oven-context, which precedes register.
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "ticket-title", action: "roadiehq:utils:jsonata" },
      { id: "sla-hours", action: "roadiehq:utils:jsonata" },
      { id: "problem-summary", action: "roadiehq:utils:jsonata" },
      { id: "audit-tag", action: "roadiehq:utils:jsonata" },
      { id: "oven-lookup", action: "bakery:catalog-lookup" },
      { id: "oven-context", action: "roadiehq:utils:jsonata" },
      { id: "register", action: "bakery:raise-ticket" },
    ]);
  });

  test("every reachable derive is emitted — no unreachable-derive diagnostic", () => {
    expect(diagnostics).toBeUndefined();
  });

  test("a derived step's `data` is generated from its inputs; `expression` is the lambda", () => {
    const ticket = object.spec.steps.find((s) => s.id === "ticket-title")!.input as {
      data: Record<string, string>;
      expression: string;
    };
    // The data map is exactly the three referenced inputs, each a ${{ }} ref.
    expect(Object.keys(ticket.data)).toEqual(["bakeryCode", "ovenId", "severity"]);
    for (const v of Object.values(ticket.data)) expect(v).toMatch(/^\$\{\{.*\}\}$/);
    // The expression is JSONata (bare data keys), never a ${{ }} template.
    expect(ticket.expression).not.toContain("${{");
    expect(ticket.expression).toContain("severity");
  });

  test("the SSA derive reads the manual lookup step's output", () => {
    const ctx = object.spec.steps.find((s) => s.id === "oven-context")!.input as { data: Record<string, string> };
    expect(ctx.data.model).toContain('steps["oven-lookup"].output.model');
  });

  test("consuming a handle auto-wires ${{ steps['<name>'].output.result }}", () => {
    const register = object.spec.steps.find((s) => s.id === "register")!.input as Record<string, string>;
    expect(register.title).toBe("${{ steps['ticket-title'].output.result }}");
    expect(register.oven).toBe("${{ steps['oven-context'].output.result }}");
  });

  test("output references derived handles and a step output", () => {
    expect(object.spec.output).toEqual({
      title: "${{ steps['ticket-title'].output.result }}",
      slaHours: "${{ steps['sla-hours'].output.result }}",
      ticketId: "${{ steps.register.output.ticketId }}",
      audit: "${{ steps['audit-tag'].output.result }}",
    });
  });
});

describe("oven-support — byte-equivalence with hand-written roadie steps", () => {
  // The SAME template, but the derived values are hand-written as
  // `roadiehq:utils:jsonata` steps (data maps + auto-wired references spelled out),
  // in the planner's order. The derive-authored template must compile BYTE-for-byte
  // to this. Expressions come from `getDeriveExpr` (the exact transpiled string a
  // derive emits) — their SEMANTICS are proven separately by the differential below.
  const model = nj<NjContext, string>((c) => c.steps["oven-lookup"].output.model);
  const year = nj<NjContext, number>((c) => c.steps["oven-lookup"].output.installedYear);

  const HandWritten = defineTemplate({
    id: "oven-support-request",
    title: "Request oven support",
    description: "Raise an oven-support ticket, assembling its fields from the submitted form.",
    type: "service",
    tags: ["bakery", "oven", "support"],
    owner: "team-bakery",
    parameters: [
      page("Oven and site", { bakeryCode, ovenId }),
      page("The problem", { severity, problemArea, otherDetail }),
    ],
    steps: () => [
      step("ticket-title", "roadiehq:utils:jsonata", {
        name: "Ticket Title",
        input: {
          data: { bakeryCode: bakeryCode.ref, ovenId: ovenId.ref, severity: severity.ref },
          expression: getDeriveExpr(ticketTitle).jsonata,
        },
      }),
      step("sla-hours", "roadiehq:utils:jsonata", {
        name: "Sla Hours",
        input: { data: { severity: severity.ref }, expression: getDeriveExpr(slaHours).jsonata },
      }),
      step("problem-summary", "roadiehq:utils:jsonata", {
        name: "Problem Summary",
        input: {
          data: { problemArea: problemArea.ref, otherDetail: otherDetail.ref },
          expression: getDeriveExpr(problemSummary).jsonata,
        },
      }),
      step("audit-tag", "roadiehq:utils:jsonata", {
        name: "Audit Tag",
        input: {
          data: { bakeryCode: bakeryCode.ref, severity: severity.ref },
          expression: getDeriveExpr(auditTag).jsonata,
        },
      }),
      step("oven-lookup", "bakery:catalog-lookup", {
        name: "Look up the oven in the catalog",
        input: { asset: ovenId.ref },
      }),
      step("oven-context", "roadiehq:utils:jsonata", {
        name: "Oven Context",
        input: { data: { model, installedYear: year }, expression: getDeriveExpr(ovenContext).jsonata },
      }),
      step("register", "bakery:raise-ticket", {
        name: "Raise the support ticket",
        input: {
          title: raw`\${{ steps['ticket-title'].output.result }}`,
          slaHours: raw`\${{ steps['sla-hours'].output.result }}`,
          summary: raw`\${{ steps['problem-summary'].output.result }}`,
          oven: raw`\${{ steps['oven-context'].output.result }}`,
          site: bakeryCode.ref,
        },
      }),
    ],
    output: () => ({
      title: raw`\${{ steps['ticket-title'].output.result }}`,
      slaHours: raw`\${{ steps['sla-hours'].output.result }}`,
      ticketId: nj<NjContext, string>((c) => c.steps["register"].output.ticketId),
      audit: raw`\${{ steps['audit-tag'].output.result }}`,
    }),
  });

  test("derive-authored YAML == hand-written roadie-step YAML", () => {
    expect(compile(OvenSupportRequest, nonprod).yaml).toBe(compile(HandWritten, nonprod).yaml);
  });
});

describe("oven-support — the derived expressions (differential vs the gold)", () => {
  test("ticket-title: transpiled JSONata == the gold's hand-written JSONata", async () => {
    await assertDifferentialJsonata(getDeriveExpr(ticketTitle), goldExpr("ticket-title"), [
      { bakeryCode: "BK1", ovenId: "OV-1", severity: "urgent" },
      { bakeryCode: "BK2", ovenId: "OV-2", severity: "normal" },
      { bakeryCode: "BK3", ovenId: "OV-3", severity: "low" },
    ]);
  });

  test("problem-summary (conditional): agrees whether otherDetail is present or absent", async () => {
    await assertDifferentialJsonata(getDeriveExpr(problemSummary), goldExpr("problem-summary"), [
      { problemArea: "other", otherDetail: "Door seal warped" }, // present → verbatim
      { problemArea: "other" }, // absent → "unspecified"
      { problemArea: "heating" }, // not "other" → the area itself
    ]);
  });

  test("audit-tag: transpiled JSONata == the gold's hand-written JSONata", async () => {
    await assertDifferentialJsonata(getDeriveExpr(auditTag), goldExpr("audit-tag"), [
      { bakeryCode: "BK1", severity: "urgent" },
      { bakeryCode: "BK3", severity: "low" },
    ]);
  });
});

describe("oven-support — schema validity (both sides)", () => {
  test("the COMPILED entity is schema-valid", async () => {
    await assertValid(compile(OvenSupportRequest, nonprod).object);
  });

  test("the HAND-WRITTEN gold is schema-valid", async () => {
    const { valid, errors } = await validate(parse(gold));
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("oven-support — whole-run agreement vs the gold", () => {
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      await assertExecuteAgainstGold(OvenSupportRequest, gold, scenario.fixture);
    });
  }
});
