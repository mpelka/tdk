// Error formatting for the CLI — the ONE place a thrown value becomes the text a
// caller (the VS Code extension, a coding-agent loop, a human at a terminal)
// reads on stderr. Pure: it never writes a stream or exits; `cli.ts` owns those.
//
// The contract callers parse — and this module must keep byte-for-byte — is:
//   - a Bun build/syntax failure renders as `<file>:<line>:<col>: <message>`
//     lines (an AggregateError with `.errors[]`, OR a bare single BuildMessage
//     carrying `.position` directly — Bun raises both shapes);
//   - a primitive throw (`throw "boom"`) surfaces bare via `String(err)`;
//   - a message-bearing non-Error (e.g. a position-less Bun ResolveMessage)
//     prefers its `.message` over `String(err)`'s `"ResolveMessage: …"` prefix;
//   - anything else falls back to its `Error.message` / `String`.

/** A Bun build-message position (`line` and `column` are 1-based). */
export interface ErrorPosition {
  file?: string;
  line?: number;
  column?: number;
}

/**
 * Format an error for stderr. Bun raises build/syntax failures either as an
 * `AggregateError` whose `.errors[]` each carry a `position { file, line,
 * column }`, or — for exactly ONE build error — as a bare `BuildMessage` (NOT
 * `instanceof Error`) with the `position` directly on it. Both render as
 * `<file>:<line>:<col>: <message>` (line and column passed through as Bun
 * reports them, 1-based — matching Bun's own display) so a caller — e.g. the
 * VS Code extension — can place a precise diagnostic. Anything else (a TDK
 * transpile / env-safety / "no template" error) falls back to its message.
 */
export function formatError(err: unknown): string {
  const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : undefined;
  const list =
    Array.isArray(obj?.errors) && obj.errors.length
      ? (obj.errors as Array<{ message?: string; position?: ErrorPosition | null }>)
      : obj?.position && typeof obj.position === "object"
        ? [obj as { message?: string; position?: ErrorPosition | null }]
        : undefined;
  if (list) {
    return list
      .map((e) => {
        const p = e.position;
        const where = p?.file && p.line != null ? `${p.file}:${p.line}:${p.column ?? 1}: ` : "";
        return `${where}${e.message ?? "error"}`;
      })
      .join("\n");
  }
  if (err instanceof Error) return err.message;
  // Message-bearing non-Errors (e.g. a position-less Bun ResolveMessage):
  // prefer the message over String(err)'s "ResolveMessage: ..." prefix.
  if (typeof obj?.message === "string") return obj.message;
  return String(err);
}
