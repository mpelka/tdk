// Group a Backstage dry-run's flat run LOG by step, and pair each step's log lines
// with its executed-step metadata — the pure transform behind the dry-run trace's
// per-step presentation. No `vscode`, no I/O: unit-tested directly.
//
// THE INPUT. A dry-run's `log` is a flat array of `{ body: { stepId?, status?, message } }`
// entries in emission order. The FIRST entries have no `stepId` (task-level lines like
// "Starting up task with N steps"); the rest carry the `stepId` of the step that emitted
// them. The `steps` array lists every executed step (`{ id, name, action, input }`) in
// order — the authoritative step list (a step can appear in `steps` yet emit no log line,
// e.g. a skipped one).
//
// THE OUTPUT. A `GroupedLog`:
//   - `preamble`: the leading stepId-less lines (the task banner), shown above the steps.
//   - `steps`: one `GroupedStep` per executed step, in `steps` order, each carrying its
//     metadata (id/name/action/input), its own log lines, and a rolled-up `status`
//     (the last `status` field any of its lines reported — `completed` / `failed` /
//     `processing`, else `unknown`). A step with no lines still appears (empty `lines`).
//   - `orphans`: log lines whose `stepId` matched no executed step (defensive — should
//     be empty in practice, but never silently dropped).

import type { DryRunLogEntry, DryRunStep } from "@tdk/core/backstage";

/** One log line, flattened to the fields the view renders. */
export interface GroupedLogLine {
  /** The emitting step's id, or undefined for a task-level (preamble) line. */
  stepId?: string;
  /** The line's status field, when it carried one (`processing`/`completed`/`failed`). */
  status?: string;
  /** The message text (defaults to "" when absent). */
  message: string;
}

/** A step's rolled-up status for the rail glyph, derived from its log lines. */
export type GroupedStepStatus = "completed" | "failed" | "skipped" | "processing" | "unknown";

/** One executed step with its metadata, its own log lines, and a rolled-up status. */
export interface GroupedStep {
  id: string;
  name?: string;
  action?: string;
  input?: unknown;
  status: GroupedStepStatus;
  lines: GroupedLogLine[];
}

/** The whole grouping: the task preamble, the per-step groups, and any unmatched lines. */
export interface GroupedLog {
  preamble: GroupedLogLine[];
  steps: GroupedStep[];
  orphans: GroupedLogLine[];
}

/** Flatten a raw `DryRunLogEntry` into the `{ stepId, status, message }` fields we render. */
function flattenLine(entry: DryRunLogEntry): GroupedLogLine {
  const body = entry.body ?? {};
  return {
    stepId: typeof body.stepId === "string" ? body.stepId : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    message: typeof body.message === "string" ? body.message : "",
  };
}

/**
 * Whether a log line is the scaffolder's "skipped because its `if:` was false" signal.
 * Keyed on the STRUCTURED `status: "skipped"` field ALONE — live-confirmed: Backstage's
 * real skip line (`Skipping step <id> because its if condition was false`) always carries
 * it (see the captured `dryRunResponse.skipped.bakery.json` fixture). Matching the message
 * TEXT would be spoofable: a step whose own output (e.g. a `debug:log` message) echoes that
 * literal sentence would mis-mark ITSELF as skipped — wrong glyph, wrong note,
 * expression-only inputs on a step that actually ran.
 */
function isSkipLine(line: GroupedLogLine): boolean {
  return line.status === "skipped";
}

/**
 * Roll a step's log lines up to a single status for the rail glyph: `failed` wins over
 * everything (any failed line means the step failed), then a SKIP signal (an `if:` that was
 * false — the step ran nothing), then `completed`, then `processing`; a step whose lines
 * carried no status at all is `unknown`.
 *
 * The skip check outranks `completed`/`processing` because a skipped step still emits a
 * leading `Beginning step …` line (status `processing`): without ranking the skip signal
 * above it, a skipped step would roll up to `processing` → the wrong ✓ glyph (the exact
 * fidelity bug this fixes). A `failed` line still wins over a skip — a step can't both fail
 * and be cleanly skipped, and an error is the more urgent thing to surface.
 */
function rollUpStatus(lines: GroupedLogLine[]): GroupedStepStatus {
  let seen: GroupedStepStatus = "unknown";
  for (const line of lines) {
    if (line.status === "failed") return "failed";
    if (isSkipLine(line)) seen = "skipped";
    else if (line.status === "completed" && seen !== "skipped") seen = "completed";
    else if (line.status === "processing" && seen === "unknown") seen = "processing";
  }
  return seen;
}

/**
 * Group a dry-run's flat `log` by step and pair each step with its `steps` metadata.
 * The `steps` array is authoritative for which steps exist and their order; the log
 * supplies each step's lines + status. Leading stepId-less lines become the preamble;
 * lines whose stepId matches no step become orphans (never dropped).
 */
export function groupLog(log: DryRunLogEntry[], steps: DryRunStep[]): GroupedLog {
  const lines = log.map(flattenLine);

  // The preamble = the leading run of stepId-less lines (the task banner). Once the
  // first step-scoped line appears, later stepId-less lines (rare) fall through to the
  // per-step bucketing as orphans rather than being mistaken for more preamble.
  let firstScoped = lines.findIndex((l) => l.stepId !== undefined);
  if (firstScoped === -1) firstScoped = lines.length;
  const preamble = lines.slice(0, firstScoped);

  // Bucket the remaining lines by stepId.
  const byStep = new Map<string, GroupedLogLine[]>();
  const orphans: GroupedLogLine[] = [];
  const stepIds = new Set(steps.map((s) => s.id));
  for (const line of lines.slice(firstScoped)) {
    if (line.stepId === undefined) {
      // A stepId-less line AFTER the preamble — keep it as an orphan (visible, not lost).
      orphans.push(line);
      continue;
    }
    if (!stepIds.has(line.stepId)) {
      orphans.push(line);
      continue;
    }
    const bucket = byStep.get(line.stepId) ?? [];
    bucket.push(line);
    byStep.set(line.stepId, bucket);
  }

  // Emit one GroupedStep per executed step, in `steps` order — a step with no lines
  // still appears (empty `lines`, `unknown` status).
  const grouped: GroupedStep[] = steps.map((s) => {
    const stepLines = byStep.get(s.id) ?? [];
    return {
      id: s.id,
      name: s.name,
      action: s.action,
      input: s.input,
      status: rollUpStatus(stepLines),
      lines: stepLines,
    };
  });

  return { preamble, steps: grouped, orphans };
}
