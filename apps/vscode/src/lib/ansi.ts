// Strip ANSI escape codes from a string — the tiny pure helper the dry-run adapter uses
// to clean Backstage's run-log lines.
//
// WHY. A real dry-run's log lines arrive coloured: `[32minfo[39m: Running …`.
// Rendered verbatim in the trace panel that shows up as literal `[32m…[39m` garbage (the
// webview is not a terminal — it does not interpret the escapes). So every log line the
// adapter emits is stripped first.
//
// THE PATTERN. A CSI sequence is `ESC [` then zero or more parameter/intermediate bytes
// then a final byte in `@`–`~`. This covers the SGR colour codes Backstage emits (`[32m`,
// `[39m`) and any other CSI escape. We deliberately do NOT touch the message text itself.

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the literal ESC () is the whole point — this strips terminal control sequences.
const ANSI_CSI = /\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove every ANSI CSI escape sequence (colours, etc.) from `text`. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}
