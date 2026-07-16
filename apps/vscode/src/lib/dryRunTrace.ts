// Normalize a Backstage dry-run's success body into the SAME `TraceStep[]` the LOCAL
// execute trace renders — the adapter that lets ONE detail component show both origins.
//
// THE TWO HALVES, mirrored from the local path. The local trace pairs the compiled
// `spec.steps[].input` (the `${{ … }}` SOURCE) against the resolved values `execute()`
// reports. A dry-run has the SAME source (Backstage echoes the template), but its resolved
// values live only in a run-LOG line ("Running … with inputs (secrets redacted): {…}").
// So we:
//   1. group the log by step (`groupLog`),
//   2. recover each step's resolved input from its log (`resolvedInputFromLog`) —
//      best-effort: where a value can't be recovered, the pairing renders EXPRESSION-ONLY,
//      never a guess,
//   3. pair source-against-resolved with the EXACT same `pairStepInputs` the local path
//      uses (so the prettified expressions and provenance rows are identical), and
//   4. attach each step's ANSI-stripped log lines as `step.log`.
//
// STATUS. A dry-run step's rolled-up log status maps to the shared rail glyph: `completed`
// → ran ✓, `failed` → error ✗, `skipped` → skipped ⤼, everything else
// (`processing`/`unknown`) → ran (the step was reached; the run simply didn't report a
// terminal status). The SKIP is read from the scaffolder's OWN log — the structured
// `status: "skipped"` field its `Skipping step … because its if condition was false` line
// carries (see logGrouping; the field, never the spoofable message text) — so a dry-run
// renders an `if:`-skipped step as ⤼, exactly as the LOCAL trace does. Before this it
// rendered the same step as the wrong ✓ (the fidelity bug). A dry-run has no `notReached`
// analogue: that is a local-simulator HALT concept, and Backstage's dry-run runs every
// reached step.
//
// OUTPUT. Backstage's dry-run response reports only the RUN's final `output`, not each
// step's — so a normalized dry-run step carries no per-step `output` (undefined). The
// detail view omits the Output section when there is nothing to show.
//
// PURE + dependency-free (no `vscode`, no I/O): unit-tested against the captured real
// response fixture.

import type { DryRunSuccessBody } from "@tdk/core/backstage";
import type { DryRunLogLine, TraceStep } from "../webview/protocol.ts";
import type { SourceStep } from "./buildTrace.ts";
import { resolvedInputFromLog } from "./dryRunResolvedInput.ts";
import { type GroupedStepStatus, groupLog } from "./logGrouping.ts";
import { pairStepInputs } from "./traceProvenance.ts";

/** Index compiled source steps by id, for the `${{ … }}` SOURCE side of each pairing. */
function indexSourceInputs(sourceSteps: SourceStep[]): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const s of sourceSteps) {
    if (typeof s.id === "string") byId.set(s.id, s.input);
  }
  return byId;
}

/** Map a step's rolled-up log status to the shared trace rail status. */
function railStatus(status: GroupedStepStatus): TraceStep["status"] {
  if (status === "failed") return "error";
  if (status === "skipped") return "skipped";
  // `completed`, `processing`, `unknown` — the step was reached and ran; `failed` is an
  // error and `skipped` an `if:`-gated skip. There is no dry-run analogue of `notReached`.
  return "ran";
}

/**
 * Normalize a dry-run success body into `TraceStep[]`. `sourceSteps` is the compiled
 * `spec.steps[]` (the `${{ … }}` source — the extension has it from the submitted YAML);
 * `parameters` is the values the form submitted (each step's `${{ }}` context). The result
 * feeds the SAME detail component as the local trace, so provenance/expressions render
 * identically.
 */
export function dryRunTraceSteps(
  body: DryRunSuccessBody,
  sourceSteps: SourceStep[],
  parameters: unknown,
): { preamble: DryRunLogLine[]; steps: TraceStep[] } {
  const grouped = groupLog(body.log, body.steps);
  const sourceById = indexSourceInputs(sourceSteps);

  const steps: TraceStep[] = grouped.steps.map((step) => {
    const log = step.lines.map((l) => ({ status: l.status, message: l.message }));
    // Recover the resolved input from this step's log; undefined → expression-only rows.
    const resolvedInput = resolvedInputFromLog(step.lines.map((l) => l.message));
    const status = railStatus(step.status);
    return {
      id: step.id,
      status,
      input: resolvedInput,
      output: undefined, // dry-run reports only the RUN's output, not per-step
      // A failed step surfaces its failed log lines as the error body (the detail shows
      // the Log section too, so the message is never lost).
      error: status === "error" ? failedLineText(log) : undefined,
      provenance: pairStepInputs(sourceById.get(step.id), resolvedInput),
      context: { parameters },
      log,
    };
  });

  // The preamble (task-banner) lines carry the orphan lines too, so they are never lost —
  // matching the previous presentation. ANSI is stripped upstream in `presentDryRun`.
  const preamble = [...grouped.preamble, ...grouped.orphans].map((l) => ({ status: l.status, message: l.message }));
  return { preamble, steps };
}

/** The joined text of a step's failed log lines — the error body for a failed dry-run step. */
function failedLineText(log: DryRunLogLine[]): string | undefined {
  const failed = log.filter((l) => l.status === "failed").map((l) => l.message);
  if (failed.length > 0) return failed.join("\n");
  return undefined;
}
