// De-noising a Backstage dry-run's run-LOG lines so the Log section reads as a clean run
// narrative, not the raw scaffolder dump — the pure transform behind item #3.
//
// TWO NOISES this collapses, both verified against the captured real fixtures:
//
//   1. The double-encoded inputs dump. Each action logs a line like
//        info: Running roadiehq:utils:jsonata in dry-run mode with inputs (secrets
//        redacted): { …the WHOLE inputs JSON, incl. the un-prettified expression… } {telemetry}
//      That JSON is EXACTLY what the normalized Inputs section above the log already renders
//      (prettified, with provenance). Repeating it inline — double-encoded, with a trailing
//      telemetry blob — is pure noise, so we keep the line THROUGH the colon and replace the
//      blob with a short "(inputs shown above)" note.
//
//   2. The `info: ` level prefix. Every ordinary line is prefixed `info: ` (an ANSI-coloured
//      `info` upstream, stripped by the time we see it). It carries no signal — every line
//      is info — so we drop it. But `warn:` / `error:` lines ARE signal: we KEEP them and
//      mark them (a leading ⚠/✗ glyph) so they stand out in the narrative.
//
// PURE + dependency-free (a string in, a string out): unit-tested directly over the real
// fixture bytes. ANSI is already stripped before this runs (see `presentDryRun` /
// `cleanLine`), so the marker matches on clean text.

/** The marker that precedes the resolved-input JSON in a "Running …" log line. */
const INPUTS_MARKER = "in dry-run mode with inputs (secrets redacted):";

/**
 * A leading log level, e.g. `info: …` / `warn: …` / `error: …`. Backstage prefixes each
 * ordinary run-log line with its level; we capture the level so we can drop `info` (noise —
 * every line is info) and mark `warn`/`error` (signal).
 */
const LEVEL_PREFIX = /^(info|warn|warning|error|debug):\s*/i;

/** The short note that stands in for the collapsed inputs JSON blob. */
const INPUTS_NOTE = "(inputs shown above)";

/**
 * De-noise ONE run-log line's message (already ANSI-stripped). Applies both transforms:
 *   - collapses a "Running … with inputs (secrets redacted): {…}" line to keep the prefix
 *     THROUGH the colon and replace the JSON blob with `(inputs shown above)`;
 *   - strips a leading `info:` level (keeps + marks `warn:` / `error:`, so signal stands out).
 * The order matters: the inputs line ALSO starts with `info:`, so we collapse the blob
 * FIRST (the collapsed remainder still reads "Running … (secrets redacted): (inputs shown
 * above)"), THEN strip the leading `info:` from what remains.
 */
export function denoiseLogLine(message: string): string {
  const collapsed = collapseInputsBlob(message);
  return stripOrMarkLevel(collapsed);
}

/**
 * Collapse the inputs JSON that trails the "…(secrets redacted):" marker down to a short
 * note. Everything up to and INCLUDING the colon is kept (the readable prefix — which action
 * ran); everything after (the double-encoded JSON + the telemetry blob) becomes the note. A
 * line without the marker is returned unchanged.
 */
function collapseInputsBlob(message: string): string {
  const at = message.indexOf(INPUTS_MARKER);
  if (at === -1) return message;
  const throughColon = message.slice(0, at + INPUTS_MARKER.length);
  return `${throughColon} ${INPUTS_NOTE}`;
}

/**
 * Strip a leading `info:` level (it carries no signal — every line is info), or KEEP and
 * MARK a `warn:` / `error:` line with a leading glyph so it stands out as signal in the
 * narrative. A line with no recognized level is returned unchanged.
 */
function stripOrMarkLevel(message: string): string {
  const match = message.match(LEVEL_PREFIX);
  if (!match) return message;
  const level = (match[1] ?? "").toLowerCase();
  const rest = message.slice(match[0].length);
  if (level === "warn" || level === "warning") return `⚠ warn: ${rest}`;
  if (level === "error") return `✗ error: ${rest}`;
  // `info` / `debug` — noise; drop the prefix, keep the message.
  return rest;
}
