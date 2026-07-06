// The JSONata pretty-printer.
//
// The transpiler emits a canonical SINGLE-LINE string (see transpile.ts); this
// module re-renders it with newlines + 2-space indentation so the emission that
// ships in YAML artifacts is readable — JSONata is whitespace-insensitive, and
// the `yaml` package renders multi-line strings as block scalars automatically.
//
// Formatting rules (conservative on purpose — anything unrecognised is left
// verbatim, so the output is always parse-equivalent):
//   - a short expression (≤ WIDTH chars) stays single-line — no noise for
//     `(a or b)`-scale output;
//   - a block `( stmt; stmt; final )` puts each statement on its own line,
//     closing paren aligned with the opening line's indent;
//   - a `$x := <expr>` binding recurses into its right-hand side;
//   - a ternary (parenthesized or bare) puts each branch on its own line;
//   - long object/array constructors put each member/element on its own line
//     (they are the usual payload of a block's final `return`).
//
// The scanner respects string literals (single/double-quoted, with escapes),
// backtick-quoted path steps, and regex literals (a `/` in argument position —
// after `(` or `,` — starts one; the parseInt/parseFloat shims emit them), so
// no delimiter inside any of those can confuse the splitting.
//
// This module formats TRANSPILED emissions only: `raw.jsonata` strings are
// hand-written and pass through verbatim (author formatting preserved).

/** Expressions at or under this length stay single-line. */
const WIDTH = 60;

/** Pretty-print a compact JSONata expression string. */
export function formatJsonata(src: string): string {
  return fmt(src.trim(), 0);
}

function pad(n: number): string {
  return " ".repeat(n);
}

/**
 * Format one complete (balanced) expression. `indent` is the column at which
 * the expression starts; continuation lines are indented relative to it. The
 * first line carries no leading padding (the caller places it).
 */
function fmt(expr: string, indent: number): string {
  const s = expr.trim();
  if (s.length <= WIDTH) return s;

  if (isWrapped(s, "(", ")")) {
    const inner = s.slice(1, -1).trim();
    const stmts = splitTop(inner, ";");
    if (stmts.length > 1) {
      // A block: statement per line, closing paren aligned.
      const body = stmts.map((st) => pad(indent + 2) + fmt(st, indent + 2)).join(";\n");
      return `(\n${body}\n${pad(indent)})`;
    }
    const t = splitTernary(inner);
    if (t) {
      return (
        `(${fmt(t.cond, indent + 2)}\n` +
        `${pad(indent + 2)}? ${fmt(t.whenTrue, indent + 4)}\n` +
        `${pad(indent + 2)}: ${fmt(t.whenFalse, indent + 4)})`
      );
    }
    return `(${fmt(inner, indent)})`;
  }

  if (isWrapped(s, "{", "}")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return s;
    const body = splitTop(inner, ",")
      .map((member) => pad(indent + 2) + fmtObjectMember(member, indent + 2))
      .join(",\n");
    return `{\n${body}\n${pad(indent)}}`;
  }

  if (isWrapped(s, "[", "]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return s;
    const body = splitTop(inner, ",")
      .map((el) => pad(indent + 2) + fmt(el, indent + 2))
      .join(",\n");
    return `[\n${body}\n${pad(indent)}]`;
  }

  // A `$x := <expr>` binding statement: recurse into the right-hand side.
  const bind = splitBinding(s);
  if (bind) return `${bind.name} := ${fmt(bind.value, indent)}`;

  // A bare (unparenthesized) ternary — e.g. a block's final statement.
  const t = splitTernary(s);
  if (t) {
    return (
      `${fmt(t.cond, indent)}\n` +
      `${pad(indent + 2)}? ${fmt(t.whenTrue, indent + 4)}\n` +
      `${pad(indent + 2)}: ${fmt(t.whenFalse, indent + 4)}`
    );
  }

  // Anything else (long paths, function calls, concat chains) stays verbatim.
  return s;
}

/** `"key": value` object member: keep the key inline, recurse into the value. */
function fmtObjectMember(member: string, indent: number): string {
  const m = member.trim();
  const colon = findTop(m, (ch, i) => ch === ":" && m[i + 1] !== "=");
  if (colon === -1) return fmt(m, indent);
  const key = m.slice(0, colon).trim();
  const value = m.slice(colon + 1).trim();
  return `${key}: ${fmt(value, indent)}`;
}

/** Split a top-level `$x := <expr>` binding, or undefined. */
function splitBinding(s: string): { name: string; value: string } | undefined {
  const i = findTop(s, (ch, idx) => ch === ":" && s[idx + 1] === "=");
  if (i === -1) return undefined;
  const name = s.slice(0, i).trim();
  // Only a plain variable binding is recognised (the emitter's only := form).
  if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  return { name, value: s.slice(i + 2).trim() };
}

interface TernaryParts {
  cond: string;
  whenTrue: string;
  whenFalse: string;
}

/**
 * Split a top-level `cond ? whenTrue : whenFalse`, or undefined. The matching
 * `:` is found right-associatively: every further top-level `?` requires one
 * more `:` before ours (the emitter parenthesizes nested ternaries, so in
 * practice there is exactly one pair per level).
 */
function splitTernary(s: string): TernaryParts | undefined {
  const q = findTop(s, (ch) => ch === "?");
  if (q === -1) return undefined;
  let pending = 1;
  const rest = s.slice(q + 1);
  const c = findTop(rest, (ch, i) => {
    if (ch === "?") {
      pending += 1;
      return false;
    }
    if (ch === ":" && rest[i + 1] !== "=") {
      pending -= 1;
      return pending === 0;
    }
    return false;
  });
  if (c === -1) return undefined;
  return {
    cond: s.slice(0, q).trim(),
    whenTrue: rest.slice(0, c).trim(),
    whenFalse: rest.slice(c + 1).trim(),
  };
}

/** Does `open` at position 0 match `close` as the FINAL character? */
function isWrapped(s: string, open: string, close: string): boolean {
  if (!s.startsWith(open) || !s.endsWith(close)) return false;
  let wrapped = false;
  scan(s, (_ch, i, depth) => {
    // After consuming the closing delimiter, depth returns to 0 — the wrap
    // holds only if that happens exactly at the last character.
    if (depth === 0 && i < s.length - 1) {
      wrapped = false;
      return true; // stop: the opening group closed early
    }
    if (depth === 0 && i === s.length - 1) wrapped = true;
    return false;
  });
  return wrapped;
}

/** Split `s` on a top-level separator character (nesting/string/regex-aware). */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  scan(s, (ch, i, depth) => {
    if (depth === 0 && ch === sep) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
    return false;
  });
  parts.push(s.slice(start).trim());
  return parts;
}

/** Index of the first top-level char matching `pred`, or -1. */
function findTop(s: string, pred: (ch: string, i: number) => boolean): number {
  let found = -1;
  scan(s, (ch, i, depth) => {
    if (depth === 0 && pred(ch, i)) {
      found = i;
      return true;
    }
    return false;
  });
  return found;
}

/**
 * Scan `s` tracking nesting depth while skipping string literals, backtick
 * path steps, and regex literals. `visit` sees each UNSKIPPED character with
 * the depth AFTER processing it (so a closing delimiter reports the depth it
 * returns to); returning true stops the scan.
 */
function scan(s: string, visit: (ch: string, i: number, depth: number) => boolean): void {
  let depth = 0;
  let prev = ""; // last significant (non-space, unskipped) char — for regex detection
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      i = skipString(s, i);
      prev = ch;
      continue;
    }
    if (ch === "`") {
      i = s.indexOf("`", i + 1);
      if (i === -1) return; // unterminated — bail out conservatively
      prev = "`";
      continue;
    }
    // A `/` in ARGUMENT position starts a regex literal (the emitter only puts
    // regexes right after `(` or `,`); after an operand it is division.
    if (ch === "/" && (prev === "(" || prev === "," || prev === "")) {
      i = skipRegex(s, i);
      prev = "/";
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (visit(ch, i, depth)) return;
    if (ch !== " ") prev = ch;
  }
}

/** Skip a quoted string starting at `i`; returns the index of the closing quote. */
function skipString(s: string, i: number): number {
  const quoteCh = s[i]!;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s[j] === quoteCh) return j;
  }
  return s.length; // unterminated — consume the rest
}

/** Skip a regex literal starting at `i`; returns the index of the closing `/`. */
function skipRegex(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s[j] === "/") return j;
  }
  return s.length;
}
