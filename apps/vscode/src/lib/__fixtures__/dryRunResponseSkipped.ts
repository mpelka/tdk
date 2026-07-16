// A SECOND captured, REDACTED, bakery-only Backstage dry-run response — a REAL 200 from a
// local Backstage where a step's `if:` condition was FALSE, so the scaffolder SKIPPED it.
// It exists so the adapter's skipped-step detection (item #1) and its expression-only
// fallback for a step that never ran (item #2) are pinned against reality, not a guess.
//
// THE TEMPLATE. A three-step bakery "rush order router": log the order, raise a rush
// ticket ONLY for high-priority orders (`if: ${{ (parameters.priority === "high") }}`), log
// completion. The capture was run with `priority: "normal"`, so the middle `rush-ticket`
// step was skipped — Backstage logs `Skipping step rush-ticket because its if condition was
// false` (status `skipped`) after its `Beginning step` line, and emits NO "Running … with
// inputs" line for it (so no resolved input can be recovered — the expression-only path).
//
// TWO REAL SIGNALS captured verbatim, both load-bearing:
//   - the SKIP line (`Skipping step … because its if condition was false`) the adapter reads
//     to mark the step `skipped` instead of the wrong ✓,
//   - the "Starting up task with 4 steps" banner while the template has only 3 steps — the
//     scaffolder counts an implicit trailing step the rail can't map (see logGrouping's
//     preamble/orphan handling; item #6).
//
// Push-safety: pure cake-order theme (Bob Baker / rush ticket / order routing); its only
// non-theme tokens were the OpenTelemetry span/trace ids trailing each `info:` line,
// scrubbed to fixed zeros (matching the sibling `dryRunResponse.ts` capture).

import type { DryRunSuccessBody } from "@tdk/core/backstage";
import response from "./dryRunResponse.skipped.bakery.json" with { type: "json" };

/** The captured 200 body (a run with a skipped `if:`-gated step), typed as the success shape. */
export const skippedDryRunResponse = response as unknown as DryRunSuccessBody;

/**
 * The compiled `spec.steps[]` for this run — the `${{ … }}` SOURCE the adapter pairs
 * against whatever resolved values it can recover. The middle `rush-ticket` step carries
 * an `if:` and was skipped; its `message` input is a `${{ … }}` template that never
 * resolved (so it must render expression-only, never `message → undefined`).
 */
export const skippedDryRunSourceSteps = [
  {
    id: "log-order",
    input: {
      message: '${{ ("Order for " ~ (parameters.customerName) ~ " (" ~ (parameters.priority) ~ " priority)") }}',
    },
  },
  {
    id: "rush-ticket",
    input: { message: '${{ ("RUSH ticket raised for " ~ (parameters.customerName)) }}' },
  },
  {
    id: "log-done",
    input: { message: '${{ ("Order for " ~ (parameters.customerName) ~ " routed") }}' },
  },
];

/** The form values the run submitted — a NORMAL-priority order, so the rush step is skipped. */
export const skippedDryRunParameters = {
  customerName: "Bob Baker",
  priority: "normal",
};
