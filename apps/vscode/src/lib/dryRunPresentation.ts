// Turn a classified `DryRunResult` into the `DryRunTraceMessage` the trace view renders.
// Pure — no `vscode`, no I/O (the base64 decode is injected) — so it is unit-tested
// directly. This is the bridge between the client's taxonomy and the view's presentation:
//   - ok               → NORMALIZE the run into the SAME `TraceStep[]` the local trace
//                        uses (`dryRunTraceSteps` — provenance pairing the compiled source
//                        against the values Backstage reported, each step carrying its
//                        ANSI-stripped log), decode the emitted files, carry the output +
//                        the task preamble.
//   - validationFailed → flatten each 400 error to `{ where, message }` for readable
//                        rendering.
//   - authFailed       → carry the client's message (already points at the set-token cmd).
//   - serverError /
//     unreachable      → carry the message as a single `error` line.
// Every outcome carries the `endpoint` header (baseUrl · status · duration) — the slot
// always says where it came from and how the request fared.

import type { DryRunResult, DryRunValidationError } from "@tdk/core/backstage";
import type {
  DryRunEndpoint,
  DryRunFile,
  DryRunLogLine,
  DryRunTraceMessage,
  DryRunValidationErrorView,
} from "../webview/protocol.ts";
import { stripAnsi } from "./ansi.ts";
import type { SourceStep } from "./buildTrace.ts";
import { denoiseLogLine } from "./dryRunLogDenoise.ts";
import { dryRunTraceSteps } from "./dryRunTrace.ts";

/** Decode a base64 string to UTF-8 text — injected so the module stays pure/testable. */
export type Base64Decode = (base64: string) => string;

/** What the `ok` arm needs to normalize the run into the shared trace schema. */
export interface DryRunPresentContext {
  /** The compiled `spec.steps[]` — the `${{ … }}` SOURCE side of the provenance pairing. */
  sourceSteps: SourceStep[];
  /** The values the form submitted — each step's `${{ }}` context. */
  parameters: unknown;
}

/**
 * Clean ONE log line's message for the panel: strip ANSI escape codes FIRST (so the
 * de-noiser's markers match on clean text), then DE-NOISE — collapse the double-encoded
 * inputs JSON that the Inputs section already renders, and drop the `info:` level prefix
 * (keeping + marking `warn:`/`error:`). Applied to the preamble and every step's log lines.
 * The status is never touched.
 */
function cleanLine(line: DryRunLogLine): DryRunLogLine {
  return { status: line.status, message: denoiseLogLine(stripAnsi(line.message)) };
}

/**
 * Build the trace-view message for a dry-run outcome. `title` names the template in the
 * view header; `endpoint` is the slot header line; `ctx` (the compiled source steps +
 * submitted values) drives the `ok` arm's normalization into the shared trace schema;
 * `decode` turns each emitted file's base64 body into text (the extension passes a real
 * decoder, tests pass a fake). Every arm of the client taxonomy maps to a `kind` the view
 * knows how to render.
 */
export function presentDryRun(
  result: DryRunResult,
  title: string | undefined,
  endpoint: DryRunEndpoint,
  ctx: DryRunPresentContext,
  decode: Base64Decode,
): DryRunTraceMessage {
  switch (result.kind) {
    case "ok": {
      const { preamble, steps } = dryRunTraceSteps(result.body, ctx.sourceSteps, ctx.parameters);
      const files: DryRunFile[] = result.body.directoryContents.map((f) => ({
        path: f.path,
        executable: Boolean(f.executable),
        content: capContent(safeDecode(f.base64Content, decode), f.path),
      }));
      return {
        type: "dryRunResult",
        title,
        kind: "ok",
        endpoint,
        // Strip ANSI on the way out — from the preamble and every step's log lines — so no
        // `[32m…` terminal noise reaches the (non-terminal) panel.
        preamble: preamble.map(cleanLine),
        steps: steps.map((s) => ({ ...s, log: s.log?.map(cleanLine) })),
        output: result.body.output,
        files,
      };
    }
    case "validationFailed":
      return {
        type: "dryRunResult",
        title,
        kind: "validationFailed",
        endpoint,
        errors: result.errors.map(flattenValidationError),
      };
    case "authFailed":
      return { type: "dryRunResult", title, kind: "authFailed", endpoint, message: result.message };
    case "serverError":
      return {
        type: "dryRunResult",
        title,
        kind: "error",
        endpoint,
        message: `Backstage returned an error (status ${result.status}). ${result.message}`,
      };
    case "unreachable":
      return { type: "dryRunResult", title, kind: "error", endpoint, message: result.message };
  }
}

/**
 * Build the slot header `endpoint` from a classified result + the measured duration. The
 * `status` is the HTTP status for a request that got a response (`ok` → 200, the failure
 * arms carry their status), or the taxonomy LABEL "unreachable" when the request never got
 * one — so the header shows a status the user can act on either way.
 */
export function dryRunEndpoint(result: DryRunResult, baseUrl: string, durationMs: number): DryRunEndpoint {
  return { baseUrl, status: endpointStatus(result), durationMs };
}

/** The header status for each taxonomy arm: an HTTP status, or a label when there is none. */
function endpointStatus(result: DryRunResult): string {
  switch (result.kind) {
    case "ok":
      return "200";
    case "validationFailed":
      return "400";
    case "authFailed":
    case "serverError":
      return String(result.status);
    case "unreachable":
      return "unreachable";
  }
}

/**
 * Flatten a server-side validation error to `{ where, message }`. `where` is a human
 * location: the `argument` (the offending property, e.g. `flavor`) for a `required`
 * error, else the `path` joined (`items.0.qty`), else `root`. The message is the
 * server's, trimmed.
 */
export function flattenValidationError(err: DryRunValidationError): DryRunValidationErrorView {
  return { where: errorLocation(err), message: err.message };
}

/** Compute the readable location for a validation error (see `flattenValidationError`). */
function errorLocation(err: DryRunValidationError): string {
  if (err.name === "required" && typeof err.argument === "string" && err.argument) {
    return err.argument;
  }
  if (Array.isArray(err.path) && err.path.length > 0) {
    return err.path.join(".");
  }
  if (typeof err.property === "string" && err.property && err.property !== "instance") {
    return err.property;
  }
  return "root";
}

/** Decode base64, but never throw — a malformed body degrades to a visible placeholder. */
function safeDecode(base64: string, decode: Base64Decode): string {
  try {
    return decode(base64);
  } catch {
    return "(could not decode file content)";
  }
}

/**
 * Per-file cap on decoded content shipped to the webview / virtual docs. A dry-run
 * emitting many MB would inflate the postMessage payload and memory for content
 * nobody scrolls — truncate LOUDLY (never silently) past 512 KB.
 */
const MAX_FILE_CHARS = 512 * 1024;

function capContent(content: string, path: string): string {
  if (content.length <= MAX_FILE_CHARS) return content;
  const totalKb = Math.round(content.length / 1024);
  return `${content.slice(0, MAX_FILE_CHARS)}\n… (truncated: ${path} is ${totalKb} KB; showing the first 512 KB)\n`;
}
