// Build the enriched per-step trace the TDK Trace view renders, from the two halves
// the extension already has: the RESOLVED run (the `execute --fixture-stdin` report)
// and the SOURCE steps (parsed from the compiled YAML, whose `input` still holds the
// `${{ … }}` template strings). Pure and unit-tested — no `vscode`, no I/O.
//
// For each resolved step, in execution order, it produces a `TraceStep` with:
//   - `status`: ran / skipped / error (from the resolved flags).
//   - `provenance`: `pairStepInputs(sourceInput, resolvedInput)` — the source
//     expression paired with the resolved value, per input key (see traceProvenance).
//   - `context`: what `${{ }}` could see AT this step — the run's `parameters`. Prior
//     steps' outputs are NOT folded in: the trace rail already lets you select an
//     earlier step to read its output, so carrying them in every step's context was
//     redundant noise.
//
// The SOURCE steps are matched to resolved steps by step id (the compiled
// `spec.steps[].id`). A resolved step with no matching source (or a source with no
// `input`) still renders — its inputs pair against `{}`, so the resolved values show
// as bare literals.

import type { TraceStep } from "../webview/protocol.ts";
import { pairStepInputs } from "./traceProvenance.ts";

/** One resolved step from the `execute` report (RESOLVED input/output, jsonata error). */
export interface ResolvedStep {
  id: string;
  skipped?: boolean;
  /**
   * True when an EARLIER step errored and HALTED the run before this one could execute
   * (real Backstage stops the task at the first failed step; `execute()` mirrors it). Such
   * a step has no input/output — it renders the distinct "not reached" rail state, no
   * Inputs/Output/Context sections.
   */
  notReached?: boolean;
  input: unknown;
  output: unknown;
  error?: string;
}

/** One source step from the compiled YAML (`spec.steps[]`), holding `${{ … }}` inputs. */
export interface SourceStep {
  id?: string;
  input?: unknown;
}

/** Collapse a resolved step's flags into the rail's status glyph. */
function stepStatus(step: ResolvedStep): TraceStep["status"] {
  // `notReached` takes precedence: a halted-past step carries no error of its own, so the
  // error/skipped checks below would misread it as a plain "ran".
  if (step.notReached) return "notReached";
  if (typeof step.error === "string") return "error";
  if (step.skipped) return "skipped";
  return "ran";
}

/** Index the source steps by id for a per-resolved-step lookup of the `${{ }}` input. */
function indexSourceInputs(sourceSteps: SourceStep[]): Map<string, unknown> {
  const byId = new Map<string, unknown>();
  for (const s of sourceSteps) {
    if (typeof s.id === "string") byId.set(s.id, s.input);
  }
  return byId;
}

/**
 * Build the enriched `TraceStep[]` for the trace view. `resolved` is the run's steps
 * in execution order; `sourceSteps` is the compiled `spec.steps[]`; `parameters` is
 * the run's parameters (the whole of every step's context).
 *
 * Every step's context is just the run's `parameters`. Prior steps' outputs are not
 * folded in — the rail already surfaces them one selection away.
 */
export function buildTraceSteps(resolved: ResolvedStep[], sourceSteps: SourceStep[], parameters: unknown): TraceStep[] {
  const sourceById = indexSourceInputs(sourceSteps);

  return resolved.map((step) => {
    const status = stepStatus(step);
    // A `notReached` step never ran: it has no input/output to pair or show. Emit empty
    // provenance so the detail renders only its one-line "never ran" body — pairing the
    // source against an absent input would fabricate empty rows for a step that did nothing.
    if (status === "notReached") {
      return { id: step.id, status, input: undefined, output: undefined, provenance: [], context: { parameters } };
    }
    return {
      id: step.id,
      status,
      input: step.input,
      output: step.output,
      error: step.error,
      provenance: pairStepInputs(sourceById.get(step.id), step.input),
      context: { parameters },
    };
  });
}
