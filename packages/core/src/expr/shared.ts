// The shared FRONT-END for the TS→JSONata and TS→Nunjucks transpilers.
//
// Both backends parse the author's arrow SOURCE (`fn.toString()`) with the
// TypeScript compiler API and walk a whitelisted AST subset. The pieces that
// were byte-identical between them — arrow parsing, context-param validation,
// string quoting, the Bun `!0`/`!1` constant-fold, and the located-error
// plumbing — live here so the two front-ends cannot drift. The WALKERS stay
// separate: the emitted languages share almost nothing.

import ts from "typescript";

/**
 * The declaration wrapper that makes a bare arrow source parse as an
 * expression. Kept as a named constant because error locations on the FIRST
 * line must subtract its length to report author-relative columns.
 */
const WRAPPER_PREFIX = "const __tdk__ = (";

/**
 * Parse an arrow-function SOURCE string into its `ArrowFunction` node, or
 * `undefined` when the source contains no arrow at all (the caller throws its
 * own backend-specific error). Parent pointers are set so nodes can locate
 * themselves for error messages.
 */
export function parseArrowSource(src: string, filename: string): ts.ArrowFunction | undefined {
  const sf = ts.createSourceFile(
    filename,
    `${WRAPPER_PREFIX}${src});`,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
  let arrow: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (!arrow && ts.isArrowFunction(node)) arrow = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return arrow;
}

/**
 * Author-relative `line L, col C` for a node. Positions come from the wrapped
 * source, so the first line's column is shifted back by the wrapper prefix.
 */
export function nodeLocation(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const col = line === 0 ? Math.max(0, character - WRAPPER_PREFIX.length) : character;
  return `line ${line + 1}, col ${col + 1}`;
}

/** The `at:` context for an error: the offending snippet plus its location. */
function describeNode(node: ts.Node): string {
  return `${node.getText().slice(0, 80)} (${nodeLocation(node)})`;
}

/**
 * Base class for both backends' transpile errors. Carries the offending
 * source snippet (a plain string, or a NODE — preferred, since a node also
 * yields its `line:col`) and the backend's escape-hatch hint.
 */
export class ExprTranspileError extends Error {
  constructor(message: string, hint: string, at?: string | ts.Node) {
    const snippet = typeof at === "object" ? describeNode(at) : at;
    super(snippet ? `${message}\n  at: ${snippet}\n  ${hint}` : `${message}\n  ${hint}`);
    this.name = "ExprTranspileError";
  }
}

/** Strip layers of outer parentheses (identity for non-parenthesized nodes). */
export function unwrapParens(node: ts.Expression): ts.Expression {
  let n: ts.Expression = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/**
 * The Bun minifier idiom: `fn.toString()` rewrites the boolean literals
 * `true`→`!0` and `false`→`!1`. Constant-fold those back so they emit the
 * boolean; returns `undefined` when the node is not that shape.
 */
export function foldMinifiedBoolean(n: ts.PrefixUnaryExpression): "true" | "false" | undefined {
  if (n.operator !== ts.SyntaxKind.ExclamationToken || !ts.isNumericLiteral(n.operand)) return undefined;
  return n.operand.text === "0" ? "true" : "false";
}

/**
 * Validate and extract the arrow's single context parameter name ("" when the
 * arrow takes no parameter). Shape violations are reported through `fail` so
 * each backend throws its own error type; `label` names the API in messages
 * ("jsonata(...)" / "nj(...)").
 */
export function contextParamName(
  arrow: ts.ArrowFunction,
  src: string,
  label: string,
  fail: (message: string, at?: string | ts.Node) => never,
): string {
  if (arrow.parameters.length === 0) return "";
  if (arrow.parameters.length > 1) {
    fail(`${label} arrow must take exactly one context parameter.`, src.slice(0, 80));
  }
  const param = arrow.parameters[0]!;
  if (!ts.isIdentifier(param.name)) {
    fail("The context parameter must be a plain identifier (no destructuring).", param);
  }
  return param.name.text;
}

/**
 * Quote + escape a string as a double-quoted string literal. The escape set
 * (backslash, quote, \n, \r, \t) is valid in BOTH JSONata and Nunjucks string
 * literals, so the helper is shared.
 */
export function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += ch;
    }
  }
  return `${out}"`;
}
