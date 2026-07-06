// The TS → Nunjucks transpiler — the Nunjucks analog of the JSONata backend.
//
// Backstage Scaffolder interpolates `${{ … }}` blocks with Nunjucks (Jinja-like)
// templating. `nj((c) => <expr>)` lets an author write that interpolation as a
// typed TS arrow and have it compiled to the Nunjucks expression at build time.
//
// As with the JSONata backend, the author's arrow SOURCE (`fn.toString()`) is
// parsed with the TypeScript compiler API and a WHITELISTED subset of the AST is
// walked, emitting a Nunjucks expression string. Anything outside the subset
// throws a clear, located error pointing at the `raw` escape hatch (write the
// `${{ … }}` by hand).
//
// The supported subset (intentionally small — Nunjucks expressions in Scaffolder
// are short interpolations, not procedural logic):
//   - the context param is the Nunjucks root: `c.parameters.a.b` → `parameters.a.b`
//     (`c.parameters` / `c.steps` / `c.secrets` / `c.user` are the usual roots);
//   - bracket+string-literal member access is PRESERVED verbatim (so step ids
//     keep their hyphens): `c.steps['x-y'].output` → `steps['x-y'].output`;
//   - `||` → `or`, `&&` → `and`;
//   - comparisons `=== !== == != < > <= >=` and arithmetic `+ - * / %` pass
//     through — Nunjucks compiles them to the SAME JS operators (`===` stays
//     strict, `==` stays loose, `+` concatenates strings), engine-verified;
//   - ternary `cond ? a : b` → `a if cond else b` (Nunjucks order);
//   - a nullish default `x ?? v` (or `njDefault(x, v)`) → `(x if x != null else v)`
//     — Nunjucks' `default` filter only fires on UNDEFINED, not null, so the
//     null-aware inline-if is emitted instead (verified against the engine);
//   - template literals `` `a${x}b` `` → `~` concatenation (Nunjucks `~`
//     stringifies via JS String(), so even `undefined` interpolates as
//     "undefined" exactly like a JS template literal — engine-verified);
//   - string filters `.toUpperCase()` / `.toLowerCase()` / `.trim()` →
//     `| upper` / `| lower` / `| trim`;
//   - `.split(sep)` / `.replace(a, b)` / `.slice(a, b?)` → METHOD CALLS kept
//     verbatim (`s.split(",")`): Nunjucks evaluates them as the real JS string
//     methods, so the semantics agree by construction (first-occurrence
//     .replace, negative .slice). Filters were deliberately NOT used: there is
//     no `split` filter, the `slice` filter is Jinja's list-chunking (throws on
//     strings), and `replace(a, b, 1)` diverges from JS on an empty pattern;
//   - string / number / boolean literals.
//
// Scaffolder compatibility: Backstage's SecureTemplater (plugins/
// scaffolder-backend/src/lib/templating/SecureTemplater.ts) configures STOCK
// nunjucks with `variableStart: '${{'` and only sandboxes the RUNTIME
// (isolated-vm) — the expression grammar (comparisons, arithmetic, `~`,
// method calls) is core nunjucks and unrestricted. Verified against the
// Backstage source; the same stock grammar is what validateNunjucks and the
// differential harness exercise here.

import ts from "typescript";
import {
  contextParamName,
  ExprTranspileError,
  foldMinifiedBoolean,
  parseArrowSource,
  quote,
  unwrapParens,
} from "../shared.ts";

const RAW_HINT =
  "If this is intentional, write the ${{ … }} expression by hand with the raw " +
  "escape hatch: raw`${{ <nunjucks> }}`.";

/**
 * A transpile error carrying the offending source snippet for context. Prefer
 * passing the offending NODE as `at` — it renders the snippet plus its
 * author-relative `line:col`.
 */
export class NjTranspileError extends ExprTranspileError {
  constructor(message: string, at?: string | ts.Node) {
    super(message, RAW_HINT, at);
    this.name = "NjTranspileError";
  }
}

/**
 * The sentinel an emitted fragment carries for "the context root". The context
 * param itself has no Nunjucks name (the fixture IS the root), so `c` alone emits
 * this marker and member/element access strips it: `c.parameters` → `parameters`.
 * If the marker survives to the top level the author referenced the bare context,
 * which is rejected.
 */
const ROOT = "\0root\0";

/** Parse an arrow-function SOURCE string into its `ArrowFunction` node. */
function parseArrow(src: string): ts.ArrowFunction {
  const arrow = parseArrowSource(src, "__nj__.ts");
  if (!arrow) {
    throw new NjTranspileError("nj(...) expects an arrow function, e.g. nj((c) => c.parameters.x).", src.slice(0, 80));
  }
  return arrow;
}

/**
 * Transpile an arrow-function SOURCE string to a Nunjucks expression string
 * (the inner expression, WITHOUT the surrounding `${{ … }}`).
 */
export function transpileArrowSourceNj(src: string): string {
  const arrow = parseArrow(src);
  const ctx = contextParamName(arrow, src, "nj(...)", (message, at) => {
    throw new NjTranspileError(message, at);
  });
  if (ts.isBlock(arrow.body)) {
    throw new NjTranspileError(
      "nj(...) does not support block-bodied arrows — it compiles a single " +
        "expression. Use a single-expression arrow: nj((c) => <expr>).",
      arrow.body,
    );
  }
  const out = emit(unwrapParens(arrow.body), ctx);
  if (out === ROOT) {
    throw new NjTranspileError(
      "Cannot reference the bare context parameter; access a property such as " +
        `${ctx || "c"}.parameters or ${ctx || "c"}.user.`,
      src.slice(0, 80),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The walker. Each node kind either emits a Nunjucks fragment or throws.
// ---------------------------------------------------------------------------

function emit(node: ts.Expression, ctx: string): string {
  const n = unwrapParens(node);

  if (ts.isPropertyAccessExpression(n)) return emitPropertyAccess(n, ctx);
  if (ts.isElementAccessExpression(n)) return emitElementAccess(n, ctx);
  if (ts.isCallExpression(n)) return emitCall(n, ctx);
  if (ts.isBinaryExpression(n)) return emitBinary(n, ctx);
  if (ts.isPrefixUnaryExpression(n)) return emitUnary(n, ctx);
  if (ts.isConditionalExpression(n)) return emitConditional(n, ctx);
  if (ts.isTemplateExpression(n)) return emitTemplate(n, ctx);
  if (ts.isStringLiteral(n)) return quote(n.text);
  if (ts.isNoSubstitutionTemplateLiteral(n)) return quote(n.text);
  if (ts.isNumericLiteral(n)) return n.text;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (n.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (n.kind === ts.SyntaxKind.NullKeyword) return "null";
  // Bun's `fn.toString()` rewrites `undefined` to `void 0`; both → null.
  if (ts.isVoidExpression(n)) return "null";
  if (ts.isIdentifier(n)) return emitIdentifier(n, ctx);

  throw new NjTranspileError(`Unsupported syntax: ${ts.SyntaxKind[n.kind]}.`, n);
}

/** A bare identifier: only the context param (→ root marker) is valid. */
function emitIdentifier(n: ts.Identifier, ctx: string): string {
  if (n.text === ctx && ctx !== "") return ROOT;
  if (n.text === "undefined") return "null";
  throw new NjTranspileError(
    `Unknown reference "${n.text}". Nunjucks expressions may only reference the ` +
      `context parameter${ctx ? ` "${ctx}"` : ""} and literals — no closures or ` +
      "external variables.",
    n,
  );
}

/**
 * Emit an access BASE, parenthesizing when the base is a FILTER pipeline.
 * `c.s.trim().length` must emit `(s | trim).length` — the unparenthesized
 * `s | trim.length` parses as a filter named "trim.length" and fails at
 * render ("filter not found"), verified against the engine. A verbatim METHOD
 * call base (`s.split(",")[0]`) needs no parens — it is a plain postfix chain.
 */
function emitAccessBase(node: ts.Expression, ctx: string): string {
  const inner = unwrapParens(node);
  const base = emit(inner, ctx);
  const isFilterCall =
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text in STRING_FILTERS;
  return isFilterCall && base !== ROOT ? `(${base})` : base;
}

/** Member access `a.b`. The context root is stripped: `c.parameters` → `parameters`. */
function emitPropertyAccess(n: ts.PropertyAccessExpression, ctx: string): string {
  const base = emitAccessBase(n.expression, ctx);
  const name = n.name.text;
  return base === ROOT ? name : `${base}.${name}`;
}

/**
 * Element access. A STRING-literal key is preserved as a bracket access so
 * non-identifier ids (hyphens) survive: `steps['x-y']`. A numeric index stays a
 * bracket index; a computed index expression stays a bracket index too. Neither
 * of those is meaningful on the BARE context root (`c[0]`, `c[c.k]`) — the
 * fixture root is not an array and the emission would otherwise degenerate to
 * a bare literal — so root element access is rejected like the bare context.
 */
function emitElementAccess(n: ts.ElementAccessExpression, ctx: string): string {
  const base = emitAccessBase(n.expression, ctx);
  const arg = n.argumentExpression;
  if (ts.isStringLiteralLike(arg)) {
    // A string key at the root (`c['steps']`) becomes a bare root variable;
    // otherwise it stays a bracket access so non-identifier ids survive.
    return base === ROOT ? arg.text : `${base}[${quote(arg.text)}]`;
  }
  if (base === ROOT) {
    throw new NjTranspileError(
      "Cannot index the bare context parameter; access a root property such as " +
        `${ctx || "c"}.parameters.list[…] instead.`,
      n,
    );
  }
  if (ts.isNumericLiteral(arg)) {
    return `${base}[${arg.text}]`;
  }
  const idx = emit(arg, ctx);
  return `${base}[${idx}]`;
}

/** A call: string filters, the `njDefault` helper, or (rejected) anything else. */
function emitCall(n: ts.CallExpression, ctx: string): string {
  const callee = n.expression;

  // `njDefault(x, v)` → the same null-aware default as `x ?? v`.
  if (ts.isIdentifier(callee) && callee.text === "njDefault") {
    if (n.arguments.length !== 2) {
      throw new NjTranspileError("njDefault(value, fallback) takes exactly two arguments.", n);
    }
    return nullishDefault(emit(n.arguments[0]!, ctx), emit(n.arguments[1]!, ctx));
  }

  // Method call: string filters or verbatim string-method calls.
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    const filter = STRING_FILTERS[method];
    if (filter) {
      if (n.arguments.length !== 0) {
        throw new NjTranspileError(`.${method}() takes no arguments.`, n);
      }
      return `${emit(callee.expression, ctx)} | ${filter}`;
    }

    // `.split(sep)` / `.replace(a, b)` / `.slice(a, b?)` are kept as METHOD
    // CALLS — Nunjucks evaluates them as the real JS string methods, agreeing
    // with the oracle by construction (see the module header for why the
    // filters were rejected). The base is parenthesized when it is a filter
    // pipeline, like any other access on a filtered result.
    const methodCall = METHOD_CALLS[method];
    if (methodCall) {
      if (n.arguments.length < methodCall.minArgs || n.arguments.length > methodCall.maxArgs) {
        throw new NjTranspileError(`${methodCall.label} takes ${methodCall.arity}.`, n);
      }
      const base = emitAccessBase(callee.expression, ctx);
      if (base === ROOT) {
        throw new NjTranspileError("Cannot call a method on the bare context parameter.", n);
      }
      const args = n.arguments.map((a) => emit(a, ctx));
      return `${base}.${method}(${args.join(", ")})`;
    }

    throw new NjTranspileError(
      `Unsupported method ".${method}(...)". Supported: ` +
        `${Object.keys(STRING_FILTERS).join("(), ")}(), ` +
        `${Object.keys(METHOD_CALLS).join("(), ")}(), njDefault().`,
      n,
    );
  }

  throw new NjTranspileError("Unsupported call expression.", n);
}

/** JS string method → Nunjucks filter name. */
const STRING_FILTERS: Record<string, string> = {
  toUpperCase: "upper",
  toLowerCase: "lower",
  trim: "trim",
};

/** JS string methods emitted as VERBATIM Nunjucks method calls. */
const METHOD_CALLS: Record<string, { minArgs: number; maxArgs: number; label: string; arity: string }> = {
  split: { minArgs: 1, maxArgs: 1, label: ".split(sep)", arity: "exactly one argument" },
  replace: { minArgs: 2, maxArgs: 2, label: ".replace(pattern, replacement)", arity: "exactly two arguments" },
  slice: { minArgs: 1, maxArgs: 2, label: ".slice(start, end?)", arity: "one or two arguments" },
};

/**
 * The null-aware default `x ?? v` → `(x if x != null else v)`.
 *
 * Nunjucks' `default(v)` filter fires ONLY on undefined — a present `null`
 * slips through (and then renders as ""), which diverges from JS `??`.
 * Nunjucks `!=` follows JS loose equality, so `x != null` is false for BOTH
 * null and undefined — exactly the nullish test (verified against the engine
 * for null / missing / "" / 0 / false / present).
 */
function nullishDefault(value: string, fallback: string): string {
  return `(${value} if ${value} != null else ${fallback})`;
}

/**
 * Comparison + arithmetic operators that pass straight through: Nunjucks
 * compiles each of these to the SAME JavaScript operator, so the semantics
 * agree with the JS oracle by construction — `===`/`!==` stay STRICT,
 * `==`/`!=` stay JS-loose ("1" == 1 is true, "1" === 1 is false), and `+`
 * concatenates when an operand is a string. All engine-verified in
 * differential.test.ts.
 */
const PASSTHROUGH_BINARY_OPS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "===",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!==",
  [ts.SyntaxKind.EqualsEqualsToken]: "==",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.PlusToken]: "+",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
};

function emitBinary(n: ts.BinaryExpression, ctx: string): string {
  const op = n.operatorToken.kind;

  // `x ?? v` → the null-aware inline-if.
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return nullishDefault(emit(n.left, ctx), emit(n.right, ctx));
  }

  if (op === ts.SyntaxKind.BarBarToken) {
    return `(${emit(n.left, ctx)} or ${emit(n.right, ctx)})`;
  }

  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return `(${emit(n.left, ctx)} and ${emit(n.right, ctx)})`;
  }

  const mapped = PASSTHROUGH_BINARY_OPS[op];
  if (mapped) {
    // Always parenthesize to preserve precedence regardless of context.
    return `(${emit(n.left, ctx)} ${mapped} ${emit(n.right, ctx)})`;
  }

  throw new NjTranspileError(
    `Unsupported binary operator "${n.operatorToken.getText()}". Supported: ` +
      "|| (→ or), && (→ and), ?? (→ null-aware inline if), " +
      "=== !== == != < > <= >=, and + - * / %.",
    n,
  );
}

/**
 * Supported prefix-unaries: the Bun minifier idiom (`fn.toString()` rewrites
 * `true`→`!0` and `false`→`!1` — constant-folded back to the boolean) and a
 * NEGATIVE NUMERIC LITERAL (`-2`, e.g. in `.slice(-2)` — folded to the
 * literal, which Nunjucks parses natively). Any other prefix-unary is outside
 * the Nunjucks subset and is rejected.
 */
function emitUnary(n: ts.PrefixUnaryExpression, _ctx: string): string {
  const folded = foldMinifiedBoolean(n);
  if (folded) return folded;
  if (n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand)) {
    return `-${n.operand.text}`;
  }
  throw new NjTranspileError(`Unsupported unary operator "${ts.tokenToString(n.operator) ?? n.operator}".`, n);
}

/** Ternary `cond ? a : b` → Nunjucks `(a if cond else b)`. */
function emitConditional(n: ts.ConditionalExpression, ctx: string): string {
  const cond = emit(n.condition, ctx);
  const whenTrue = emit(n.whenTrue, ctx);
  const whenFalse = emit(n.whenFalse, ctx);
  return `(${whenTrue} if ${cond} else ${whenFalse})`;
}

/**
 * Template literal `` `a${x}b` `` → `("a" ~ (x) ~ "b")`. Nunjucks `~`
 * stringifies each operand with JS String(), so numbers, booleans, null AND
 * undefined all interpolate exactly like a JS template literal (engine-
 * verified — including `undefined` → "undefined"). A single bare
 * interpolation gets a `~ ""` so the result is string-typed like JS.
 */
function emitTemplate(n: ts.TemplateExpression, ctx: string): string {
  const parts: string[] = [];
  if (n.head.text !== "") parts.push(quote(n.head.text));
  for (const span of n.templateSpans) {
    // Wrap the interpolated expression so `~` binds correctly.
    parts.push(`(${emit(span.expression, ctx)})`);
    if (span.literal.text !== "") parts.push(quote(span.literal.text));
  }
  if (parts.length === 0) return quote("");
  if (parts.length === 1) {
    // Single interpolation with empty head/tail: still coerce to string via ~"".
    return `(${parts[0]} ~ "")`;
  }
  return `(${parts.join(" ~ ")})`;
}

// Re-export the shared quote helper (historical import site for tests).
export { quote };
