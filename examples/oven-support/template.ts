// EXAMPLE 6 — "Oven Support Request": the derive (dataflow) stress test.
//
// The ADR-0025 oven-support shape, authored with `derive(name, inputs, fn)` — a
// bakery raises an oven-support ticket in the service catalog. It exercises every
// corner of phase-3a's derived-value planning:
//
//   - FIVE derived values, each a `derive(...)`: three from parameters
//     (`ticket-title`, `sla-hours`, `problem-summary`), one from a MANUAL step's
//     output (`oven-context`, reads `oven-lookup`), and one reached ONLY by the
//     template output (`audit-tag`).
//   - CONDITIONALITY: `problem-summary` reads `otherDetail`, a field with a
//     `.showWhen(...)`, so `i.otherDetail` types as `string | undefined` and the
//     lambda must handle absence (`|| "unspecified"`).
//   - AUTO-WIRING: consuming a handle emits `${{ steps['<name>'].output.result }}`
//     — never written by hand — in the manual steps' inputs and the output.
//   - TOPOLOGICAL PLANNING: the compiler materializes each reachable derive as a
//     `roadiehq:utils:jsonata` step and interleaves them with the two manual steps
//     so every reference resolves. The SSA-shaped chain is
//     `oven-lookup` (manual) → `oven-context` (derive) → `register` (manual).
//
// The lambdas transpile through the SAME TS→JSONata transpiler `jsonata()` uses,
// so the gold-standard.yaml hand-writes the equivalent roadie steps and the tests
// prove value-for-value agreement (`assertExecuteAgainstGold`, the differential
// harness), plus a byte-equivalence check against hand-written roadie steps.

import { defineTemplate, derive, type NjContext, nj, p, page, step } from "@tdk/core";

// --- Fields (hoisted consts, so the derives can reference them directly) --------
// Page 1 — oven and site.
export const bakeryCode = p.choice(
  { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
  { title: "Bakery site", required: true },
);
export const ovenId = p.string({ title: "Oven asset ID", required: true });

// Page 2 — the problem. `otherDetail` is CONDITIONAL (shown only for "other"), via
// the `.showWhen(...)` METHOD — so its field ref types as `string | undefined`.
export const severity = p.choice(
  { low: "Low", normal: "Normal", urgent: "Urgent" },
  { title: "Severity", required: true },
);
export const problemArea = p.choice(["heating", "conveyor", "controls", "other"], {
  title: "Problem area",
  required: true,
});
export const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));

// --- Derived values -------------------------------------------------------------
// Params-only. Multi-input: the title folds three fields (and flags urgency).
export const ticketTitle = derive(
  "ticket-title",
  { bakeryCode, ovenId, severity },
  (i) => `${i.severity === "urgent" ? "[URGENT] " : ""}Oven ${i.ovenId} at ${i.bakeryCode}`,
);

// Single-input. A support SLA in hours, by severity.
export const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);

// CONDITIONAL: `i.otherDetail` is `string | undefined` — the lambda handles the
// absence the type surfaces (`|| "unspecified"`), exactly as ADR-0025 §2 shows.
export const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);

// SSA-shaped: reads the `oven-lookup` MANUAL step's output via `nj` markers, so
// the planner orders it AFTER `oven-lookup` and BEFORE `register` (which reads it).
export const ovenContext = derive(
  "oven-context",
  {
    model: nj<NjContext, string>((c) => c.steps["oven-lookup"].output.model),
    installedYear: nj<NjContext, number>((c) => c.steps["oven-lookup"].output.installedYear),
  },
  (i) => `${i.model} (installed ${i.installedYear})`,
);

// Reached ONLY by the template output — proving output is a reachability root.
export const auditTag = derive("audit-tag", { bakeryCode, severity }, (i) => `${i.bakeryCode}:${i.severity}`);

export const OvenSupportRequest = defineTemplate({
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
    // Manual: fetch the oven's catalog record. Its output is mocked in scenarios;
    // `oven-context` derives from it.
    step("oven-lookup", "bakery:catalog-lookup", {
      name: "Look up the oven in the catalog",
      input: { asset: ovenId.ref },
    }),
    // Manual: raise the ticket, consuming the derived values by handle. Every
    // `${{ steps['…'].output.result }}` reference is auto-wired.
    step("register", "bakery:raise-ticket", {
      name: "Raise the support ticket",
      input: {
        title: ticketTitle,
        slaHours,
        summary: problemSummary,
        oven: ovenContext,
        site: bakeryCode.ref,
      },
    }),
  ],
  output: () => ({
    title: ticketTitle,
    slaHours,
    ticketId: nj<NjContext, string>((c) => c.steps["register"].output.ticketId),
    audit: auditTag,
  }),
});
