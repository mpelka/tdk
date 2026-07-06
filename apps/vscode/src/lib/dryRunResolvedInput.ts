// Recovering a dry-run step's RESOLVED input from its run log — the best-effort half of
// the dry-run provenance pairing.
//
// WHY THIS EXISTS. A dry-run's `steps[].input` still holds the `${{ … }}` SOURCE strings
// (Backstage reports the template, not the render), exactly like the compiled YAML. The
// RESOLVED values — what those templates actually became — are only reported in a LOG
// line the action emits as it runs:
//
//   [32minfo[39m: Running <action> in dry-run mode with inputs (secrets redacted): {…JSON…} {…telemetry…}
//
// The FIRST `{…}` after the marker is the resolved input (pretty-printed JSON); a SECOND
// `{…}` telemetry blob (`{"span_id":…,"trace_id":…}`) trails it. We extract the first
// balanced-brace object and parse it. Where no such line exists, or it doesn't parse, we
// return `undefined` — the caller then renders EXPRESSION-ONLY provenance (never a guessed
// value). Verified against a real local-Backstage response (see the captured fixture).
//
// PURE + dependency-free: a string in, a value (or undefined) out — unit-tested directly.

import { stripAnsi } from "./ansi.ts";

/** The marker that precedes the resolved-input JSON in a dry-run "Running …" log line. */
const INPUTS_MARKER = "in dry-run mode with inputs (secrets redacted):";

/**
 * Extract the balanced-brace `{…}` substring that starts IMMEDIATELY after `from` in
 * `text` (optional whitespace only), respecting braces inside JSON string literals (so a
 * `}` inside a value doesn't close it early). Returns the substring, or undefined when the
 * first non-whitespace character after `from` is not `{` or no balanced object follows.
 *
 * The immediacy requirement is load-bearing for "never guess": the resolved input is the
 * FIRST thing after the marker, but a TRAILING telemetry `{…}` blob rides at the end of the
 * same line — a lenient "find the next `{` anywhere" would latch onto that telemetry blob
 * whenever the input itself were malformed-but-not-a-brace, and present telemetry as the
 * step's input.
 */
function firstBalancedObject(text: string, from: number): string | undefined {
  let start = from;
  while (start < text.length && /\s/.test(text[start] as string)) start++;
  if (text[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined; // unbalanced — never guess
}

/**
 * Recover a step's resolved input from ONE of its log lines, or undefined when none
 * carries it. Scans for the "Running … with inputs (secrets redacted): {…}" line (after
 * stripping ANSI so the marker matches), extracts the first balanced-brace object after
 * the marker, and JSON-parses it. A missing marker, a missing/unbalanced object, or a
 * parse failure all yield undefined — the caller renders expression-only provenance.
 */
export function resolvedInputFromLog(messages: string[]): unknown {
  for (const raw of messages) {
    const line = stripAnsi(raw);
    const markerAt = line.indexOf(INPUTS_MARKER);
    if (markerAt === -1) continue;
    const object = firstBalancedObject(line, markerAt + INPUTS_MARKER.length);
    if (object === undefined) continue;
    try {
      return JSON.parse(object);
    } catch {
      return undefined; // a malformed blob — expression-only, never a guess
    }
  }
  return undefined;
}
