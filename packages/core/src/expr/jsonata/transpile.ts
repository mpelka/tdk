// The TS → JSONata transpiler.
//
// Given the SOURCE of an author's arrow function (from `fn.toString()`), parse
// it with the TypeScript compiler API and walk a WHITELISTED subset of the AST,
// emitting a JSONata expression string with explicit parenthesization to
// preserve precedence. Anything outside the whitelist throws a clear, located
// error that names the construct and points at the `raw.jsonata` escape hatch.
//
// Design notes:
//   - We emit the string directly (option (b) from the spec) rather than
//     building a JSONata AST + serializing it. Direct emission with careful
//     parens is robust and dependency-free. The caller validates every result
//     by parsing it with `jsonata(str)`.
//   - The arrow's single param (e.g. `c`) is the JSONata ROOT, so
//     `c.parameters.x` → `parameters.x` (the param name is stripped).
//   - map/filter lambda params introduce a NESTED context: inside
//     `arr.map(m => m.email)` the `m` binds to the item, so `m.email` → `email`.
//   - Some JS constructs need a TEMPORARY JSONata variable to keep JS value
//     semantics (`a || b`, string-aware `.length`, computed indices). Those
//     temps are allocated per-transpile with a counter (`$__or1`, `$__len2`,
//     ...) and skip any name the author has bound, so they cannot collide.
//     For `||`/`&&` and `.length`, a temp exists only to evaluate a subexpr
//     ONCE; when that operand is a SIMPLE PURE lookup (`isSimplePureOperand`),
//     re-evaluating it is provably free and equal, so it is INLINED and no temp
//     is emitted — a readability win. The temp stays for anything else (any
//     call, where cost/nondeterminism make single-evaluation load-bearing) and
//     for structural reuses (`$match` groups, computed-index scoping).

import ts from "typescript";
import {
  contextParamName,
  ExprTranspileError,
  foldMinifiedBoolean,
  parseArrowSource,
  quote,
  unwrapParens,
} from "../shared.ts";
import {
  type FnMapEntry,
  GLOBAL_MAP,
  LAMBDA_ARRAY_METHODS,
  METHOD_MAP,
  PROPERTY_FN_MAP,
  SPECIAL_GLOBAL_FORMS,
  SPECIAL_METHOD_FORMS,
} from "./fnmap.ts";

/**
 * Is this operand SIMPLE and PURE — cheap to evaluate and free of side effects
 * or nondeterminism, so evaluating it TWICE is provably identical to evaluating
 * it once and stashing the result in a temp?
 *
 * Several emissions introduce a `$__` temp solely to evaluate a subexpression
 * ONCE (the `||`/`&&` left operand, the `.length` receiver) — a temp that costs
 * readability. JSONata is pure, so for a simple operand the temp is pure noise:
 * a variable reference, a context path, a literal, a fixed index — each is a
 * side-effect-free lookup whose repeat is free and equal. Only a temp guarding
 * a NONDETERMINISTIC or costly form ($millis/$random, any call) truly earns its
 * keep, so we inline the simple ones and keep the rest.
 *
 * TRUE for: identifier references (the context param, block-bound `const`/`let`,
 * `undefined`); property-access CHAINS built only from those, including optional
 * chaining and string-key (`["k"]`) access; element access with a LITERAL
 * numeric index; and literals (string/number/boolean/null). FALSE for ANY call
 * expression, a template literal with substitutions, binary/conditional/unary
 * expressions, a `.length` chain (it expands to a type-dispatch shim, not a
 * plain path), a COMPUTED element index (it hoists its own temp), and anything
 * else. When in doubt it returns FALSE — the temp is always correct, so
 * inlining is only ever a readability optimization, never a soundness one.
 */
function isSimplePureOperand(node: ts.Expression, scope: Scope): boolean {
  const n = unwrapParens(node);

  // Literals — always simple.
  if (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    n.kind === ts.SyntaxKind.NullKeyword ||
    isUndefinedLiteral(n, scope)
  ) {
    return true;
  }

  // A bare identifier: only simple if it actually resolves (context param,
  // block binding, or `undefined`) — an unknown name is not simple (it throws
  // during emit anyway, but the predicate must not claim it).
  if (ts.isIdentifier(n)) {
    return scope.bound?.has(n.text) === true || n.text === scope.contextVar || n.text === "undefined";
  }

  // A property-access CHAIN, e.g. `c.a.b?.c` — simple iff its base is simple and
  // the tail is a plain path step, NOT a shimmed property like `.length`.
  if (ts.isPropertyAccessExpression(n)) {
    if (PROPERTY_FN_MAP[n.name.text]) return false;
    return isSimplePureOperand(n.expression, scope);
  }

  // Element access — simple only with a LITERAL index (string key → path step,
  // non-negative numeric literal → fixed bracket index). A computed index hoists
  // its OWN temp (evaluation-context, not just double-eval), so it is not simple.
  if (ts.isElementAccessExpression(n)) {
    const arg = unwrapParens(n.argumentExpression);
    if (ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg)) {
      return isSimplePureOperand(n.expression, scope);
    }
    return false;
  }

  return false;
}

const RAW_HINT =
  "If this is intentional, use the escape hatch: raw.jsonata`<jsonata>` " + "(also exported as jsonata.raw).";

/**
 * A transpile error carrying the offending source snippet for context. Prefer
 * passing the offending NODE as `at` — it renders the snippet plus its
 * author-relative `line:col`.
 */
export class TranspileError extends ExprTranspileError {
  constructor(message: string, at?: string | ts.Node) {
    super(message, RAW_HINT, at);
    this.name = "TranspileError";
  }
}

/**
 * The set of identifiers that resolve to a CONTEXT root at a given scope. The
 * root context param maps to "" (JSONata root). A map/filter lambda var maps to
 * "" as well within its own body (the item is the implicit `$` context), and it
 * SHADOWS both the outer context AND any same-named block binding.
 */
interface Scope {
  /** The identifier that stands for the current JSONata context (root or item). */
  readonly contextVar: string;
  /**
   * Names bound by `const`/`let` (or reassignment) in an enclosing block body.
   * A reference to one of these emits a JSONata variable (`x` → `$x`). The set
   * is shared (and mutated) across a single block's statements as bindings are
   * introduced in source order.
   */
  readonly bound?: ReadonlySet<string>;
  /**
   * The per-transpile counter for generated temporary variables. SHARED by
   * every scope derived from the same top-level arrow so generated names are
   * unique across the whole emission.
   */
  readonly temps: { n: number };
}

/**
 * Allocate a fresh JSONata variable name for an emission-internal temporary
 * (`$__or1`, `$__idx2`, ...). The counter makes generated names unique among
 * themselves; the `bound` check skips any name the author happens to have
 * bound, so a temp can never capture — or be captured by — an author binding.
 */
function freshVar(scope: Scope, kind: string): string {
  let name: string;
  do {
    scope.temps.n += 1;
    name = `__${kind}${scope.temps.n}`;
  } while (scope.bound?.has(name));
  return `$${name}`;
}

/** Parse arrow source into the ArrowFunction node, or throw. */
function parseArrow(src: string): ts.ArrowFunction {
  const arrow = parseArrowSource(src, "__expr__.ts");
  if (!arrow) {
    throw new TranspileError(
      "jsonata(...) expects an arrow function, e.g. jsonata((c) => ({ ... })).",
      src.slice(0, 80),
    );
  }
  return arrow;
}

/**
 * Transpile an arrow-function SOURCE string to a JSONata expression string.
 *
 * @param src The result of `fn.toString()`.
 */
export function transpileArrowSource(src: string): string {
  const arrow = parseArrow(src);
  const contextVar = contextParamName(arrow, src, "jsonata(...)", (message, at) => {
    throw new TranspileError(message, at);
  });
  const scope: Scope = { contextVar, temps: { n: 0 } };
  // A block body `(c) => { ...; return e; }` becomes a JSONata block; a single
  // expression body `(c) => (<expr>)` is emitted directly.
  if (ts.isBlock(arrow.body)) return emitBlock(arrow.body, scope);
  return emit(unwrapParens(arrow.body), scope);
}

/**
 * Emit a block-bodied arrow `(c) => { ...statements; return <e>; }` as a JSONata
 * block `( $x := ...; ...; <final> )`. Supported statements, in source order:
 *   - `const x = e;` / `let x = e;`            → `$x := <e>`
 *   - reassignment `x = e;` of a DECLARED name → `$x := <e>`  (JSONata rebinds)
 *   - a bare call statement (e.g. `assert(...)`) → the emitted expression
 *   - `return e;` (must be the FINAL statement) → the block's result expression
 * A bound name resolves to its JSONata variable (`x` → `$x`) for the remainder
 * of the block. Assigning to an UNDECLARED name is rejected (strict-mode JS
 * would throw a ReferenceError there — the oracle and the emission must agree).
 * Anything else throws, pointing at the `raw.jsonata` hatch.
 */
function emitBlock(block: ts.Block, scope: Scope): string {
  // `bound` is seeded from any enclosing scope and grows as bindings appear.
  const bound = new Set<string>(scope.bound ?? []);
  const inner: Scope = { contextVar: scope.contextVar, bound, temps: scope.temps };
  const parts: string[] = [];
  let final: string | undefined;

  for (const stmt of block.statements) {
    if (final !== undefined) {
      throw new TranspileError("`return` must be the final statement in a block-bodied arrow.", stmt);
    }

    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) {
          throw new TranspileError("Destructuring bindings are not supported; bind a single name.", decl);
        }
        if (!decl.initializer) {
          throw new TranspileError(`Binding "${decl.name.text}" must have an initializer.`, decl);
        }
        // Emit the initializer BEFORE binding the name (no self-reference).
        const value = emit(unwrapParens(decl.initializer), inner);
        bound.add(decl.name.text);
        parts.push(`$${decl.name.text} := ${value}`);
      }
      continue;
    }

    if (ts.isExpressionStatement(stmt)) {
      const e = stmt.expression;
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (!ts.isIdentifier(e.left)) {
          throw new TranspileError("Only simple `name = <expr>` reassignment is supported.", e);
        }
        if (!bound.has(e.left.text)) {
          throw new TranspileError(
            `Cannot assign to undeclared name "${e.left.text}" (strict-mode JS would throw a ` +
              `ReferenceError). Declare it first: const ${e.left.text} = <expr>;`,
            e,
          );
        }
        const value = emit(unwrapParens(e.right), inner);
        parts.push(`$${e.left.text} := ${value}`);
      } else {
        // A bare statement expression, e.g. `assert(cond, msg)`.
        parts.push(emit(unwrapParens(e), inner));
      }
      continue;
    }

    if (ts.isReturnStatement(stmt)) {
      if (!stmt.expression) {
        throw new TranspileError("A block-bodied arrow must `return <expr>;` a value.", stmt);
      }
      final = emit(unwrapParens(stmt.expression), inner);
      continue;
    }

    throw new TranspileError(
      `Unsupported statement: ${ts.SyntaxKind[stmt.kind]}. Only const/let ` +
        "bindings, reassignments, bare calls, and a final return are allowed.",
      stmt,
    );
  }

  if (final === undefined) {
    throw new TranspileError("A block-bodied arrow must end with `return <expr>;`.", block);
  }
  return `(${[...parts, final].join("; ")})`;
}

// ---------------------------------------------------------------------------
// The walker. Each node kind either emits a JSONata fragment or throws.
// ---------------------------------------------------------------------------

function emit(node: ts.Expression, scope: Scope): string {
  const n = unwrapParens(node);

  if (ts.isObjectLiteralExpression(n)) return emitObject(n, scope);
  if (ts.isArrayLiteralExpression(n)) return emitArray(n, scope);
  if (ts.isPropertyAccessExpression(n)) return emitPropertyAccess(n, scope);
  if (ts.isElementAccessExpression(n)) return emitElementAccess(n, scope);
  if (ts.isCallExpression(n)) return emitCall(n, scope);
  if (ts.isBinaryExpression(n)) return emitBinary(n, scope);
  if (ts.isPrefixUnaryExpression(n)) return emitUnary(n, scope);
  if (ts.isConditionalExpression(n)) return emitConditional(n, scope);
  if (ts.isTemplateExpression(n)) return emitTemplate(n, scope);
  if (ts.isNoSubstitutionTemplateLiteral(n)) return quote(n.text);
  if (ts.isStringLiteral(n)) return quote(n.text);
  if (ts.isNumericLiteral(n)) return n.text;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (n.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (n.kind === ts.SyntaxKind.NullKeyword) return "null";
  // Bun's `fn.toString()` rewrites `undefined` to `void 0` — treat both as the
  // undefined literal (JSONata has none; comparisons are handled via $exists,
  // elsewhere it maps to `null` to stay parseable).
  if (isUndefinedLiteral(n, scope)) return "null";
  if (ts.isIdentifier(n)) return emitIdentifier(n, scope);

  throw new TranspileError(`Unsupported syntax: ${ts.SyntaxKind[n.kind]}.`, n);
}

/**
 * Is this node the JS `undefined` value — the bare `undefined` identifier (not
 * shadowed by an author binding) or the `void 0` form Bun's `fn.toString()`
 * rewrites it to?
 */
function isUndefinedLiteral(n: ts.Expression, scope: Scope): boolean {
  if (ts.isVoidExpression(n)) return true;
  return ts.isIdentifier(n) && n.text === "undefined" && !scope.bound?.has("undefined");
}

/**
 * A bare identifier. A block-bound `const`/`let` name maps to its JSONata
 * variable (`x` → `$x`); the context var maps to root (`$`); nothing else is
 * valid (no closures / external variables).
 */
function emitIdentifier(n: ts.Identifier, scope: Scope): string {
  if (scope.bound?.has(n.text)) {
    // A block-bound binding — a JSONata variable.
    return `$${n.text}`;
  }
  if (n.text === scope.contextVar) {
    // A reference to the whole context — JSONata root is `$`.
    return "$";
  }
  if (n.text === "undefined") {
    // JSONata has no undefined literal; treat as the empty/absent value.
    // Comparisons against `undefined` are handled separately (→ $exists);
    // elsewhere it maps to JSONata `null` to stay parseable.
    return "null";
  }
  throw new TranspileError(
    `Unknown reference "${n.text}". Expressions may only reference the context ` +
      `parameter "${scope.contextVar}", their own lambda parameters, and literals ` +
      `— no closures or external variables.`,
    n,
  );
}

/**
 * Object literal. Without spreads: a plain JSONata object constructor. WITH
 * spreads (`{ ...a, b: 1, ...c }`) it folds to `$merge`: runs of plain
 * properties become object segments and each `...x` contributes `x` directly,
 * preserving interleaving order — `$merge([a, {"b": 1}, c])`. JS later-wins
 * precedence matches `$merge` exactly (engine-verified). Spread of a MISSING
 * value contributes nothing on both sides (the JSONata array constructor drops
 * a missing member before `$merge` sees it — matching JS `{...undefined}`);
 * spread of a present `null` or non-object diverges (JSONata throws where JS
 * yields `{}` / spreads chars) — see expression-support.md.
 */
function emitObject(n: ts.ObjectLiteralExpression, scope: Scope): string {
  const emitPlainProp = (prop: ts.ObjectLiteralElementLike): string => {
    if (ts.isPropertyAssignment(prop)) {
      return `${quote(objectKey(prop.name))}: ${emit(prop.initializer, scope)}`;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      return `${quote(prop.name.text)}: ${emit(prop.name, scope)}`;
    }
    throw new TranspileError(
      "Only plain `key: value` object properties and `...spread`s are supported " +
        "(no methods, getters, or computed keys other than string/number literals).",
      prop,
    );
  };

  if (!n.properties.some((prop) => ts.isSpreadAssignment(prop))) {
    return `{${n.properties.map(emitPlainProp).join(", ")}}`;
  }

  const segments: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      segments.push(`{${run.join(", ")}}`);
      run = [];
    }
  };
  for (const prop of n.properties) {
    if (ts.isSpreadAssignment(prop)) {
      flush();
      segments.push(emit(prop.expression, scope));
    } else {
      run.push(emitPlainProp(prop));
    }
  }
  flush();

  return `$merge([${segments.join(", ")}])`;
}

/** Resolve an object-literal key to its string form. */
function objectKey(name: ts.PropertyName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  throw new TranspileError("Object keys must be identifiers or string/number literals.", name);
}

/**
 * Array literal. Without spreads: a plain JSONata array `[a, b, c]`. WITH
 * spreads it folds to `$append`: runs of plain elements become array segments
 * and each `...x` contributes `x` directly, so `[...a, ...b]` → `$append(a, b)`
 * and `[...a, x, ...b]` → `$append($append(a, [x]), b)`.
 */
function emitArray(n: ts.ArrayLiteralExpression, scope: Scope): string {
  if (!n.elements.some((el) => ts.isSpreadElement(el))) {
    return `[${n.elements.map((el) => emit(el, scope)).join(", ")}]`;
  }

  const segments: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      segments.push(`[${run.join(", ")}]`);
      run = [];
    }
  };
  for (const el of n.elements) {
    if (ts.isSpreadElement(el)) {
      flush();
      segments.push(emit(el.expression, scope));
    } else {
      run.push(emit(el, scope));
    }
  }
  flush();

  // A lone `[...a]` is just `a`; otherwise left-fold into nested `$append`.
  return segments.reduce((acc, seg) => `$append(${acc}, ${seg})`);
}

/**
 * Member access `a.b.c`. The chain is flattened to a JSONata path. If the base
 * of the chain is the context var, it is stripped (context = root). Property
 * names in `PROPERTY_FN_MAP` (`.length`) emit through the map's own machinery.
 * Optional chaining (`a?.b`) emits the same path — JSONata paths already
 * propagate a missing base to a missing result, which is exactly `?.`.
 */
function emitPropertyAccess(n: ts.PropertyAccessExpression, scope: Scope): string {
  const name = n.name.text;

  const propFn = PROPERTY_FN_MAP[name];
  if (propFn) {
    const base = emit(n.expression, scope);
    // A simple pure receiver can be repeated in the type-dispatch shim instead
    // of stashed in a temp — the double lookup is provably identical.
    const simple = isSimplePureOperand(n.expression, scope);
    return propFn.emit(base, (kind) => freshVar(scope, kind), simple);
  }

  const base = emit(n.expression, scope);
  const step = pathStep(name, n);
  // Stripping the context root: `$.x` would be wrong; emit just `x`.
  if (base === "$") return step;
  return `${base}.${step}`;
}

/**
 * A JSONata path step for a property name. Names that are not plain
 * identifiers (step ids like `fetch-base`) are BACKTICK-QUOTED — `obj.x-y`
 * would parse as subtraction. A backtick inside the name cannot be escaped in
 * JSONata, so that is rejected.
 */
function pathStep(key: string, at: ts.Node): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return key;
  if (key.includes("`")) {
    throw new TranspileError(
      `Property name ${JSON.stringify(key)} contains a backtick, which cannot be escaped in a JSONata path step.`,
      at,
    );
  }
  return `\`${key}\``;
}

/** Matches an emission that is exactly one JSONata variable (`$x`). */
const SINGLE_VAR = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Element access.
 *   - `a["k"]`  → path step `a.k` (backtick-quoted when `k` isn't an identifier)
 *   - `a[0]`    → JSONata index `a[0]` (NEGATIVE literals are rejected: JSONata
 *     `a[-1]` selects from the END where JS yields undefined — a silent trap)
 *   - `a[<expr>]` → the index is HOISTED into a block variable,
 *     `($__idx1 := <expr>; a[$__idx1])`. A bare `a[expr]` would evaluate the
 *     bracket in ITEM context (a JSONata predicate), not the enclosing scope.
 *     An emission that is already a variable (`a[$i]`) needs no hoisting.
 */
function emitElementAccess(n: ts.ElementAccessExpression, scope: Scope): string {
  const base = emit(n.expression, scope);
  const arg = unwrapParens(n.argumentExpression);
  if (ts.isStringLiteralLike(arg)) {
    // Property-by-name → path step.
    const step = pathStep(arg.text, n);
    return base === "$" ? step : `${base}.${step}`;
  }
  if (ts.isNumericLiteral(arg)) {
    // Array index → JSONata bracket index. `$[0]` selects from the root/item.
    return `${base}[${arg.text}]`;
  }
  if (
    ts.isPrefixUnaryExpression(arg) &&
    arg.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(arg.operand)
  ) {
    throw new TranspileError(
      `Negative literal index [-${arg.operand.text}] is not supported: JSONata selects from ` +
        "the END of the array there, while JS yields undefined — a silent divergence. " +
        "Use .slice(-n) for from-the-end access, or raw.jsonata.",
      n,
    );
  }
  // A computed index expression: hoist so it evaluates in the CURRENT scope,
  // not as a predicate in the item context of `base`.
  const idx = emit(arg, scope);
  if (SINGLE_VAR.test(idx)) return `${base}[${idx}]`;
  const v = freshVar(scope, "idx");
  return `(${v} := ${idx}; ${base}[${v}])`;
}

/** A call: array lambda methods, mapped methods, or mapped globals. */
function emitCall(n: ts.CallExpression, scope: Scope): string {
  const callee = n.expression;

  // Global functions: String(x), Number(x), Math.round(x), ...
  if (ts.isIdentifier(callee) || isQualifiedGlobal(callee)) {
    const key = callee.getText();
    // `parseInt` / `parseFloat` need a lenient $match-then-$number shim (bare
    // `$number` is a strict cast), so they are emitted here rather than mapped.
    if (ts.isIdentifier(callee) && (callee.text === "parseInt" || callee.text === "parseFloat")) {
      return emitParse(n, callee.text, scope);
    }
    const global = GLOBAL_MAP[key];
    if (global) {
      const args = n.arguments.map((a) => emit(a, scope));
      checkArity(global, args.length, n);
      return `$${global.jsonata}(${global.args(undefined, args).join(", ")})`;
    }
    // Not a known global. `isQualifiedGlobal(callee)` is only true when the
    // callee's text IS in GLOBAL_MAP (so `global` would be truthy and we'd have
    // returned above) — therefore reaching here means the callee is a bare
    // identifier that isn't a supported global.
    throw new TranspileError(
      `Unsupported function call "${key}(...)". Supported globals: ` +
        `${[...Object.keys(GLOBAL_MAP), ...Object.keys(SPECIAL_GLOBAL_FORMS)].join(", ")}.`,
      n,
    );
  }

  // Method call: <receiver>.<method>(...)
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;

    // An unknown call on a KNOWN GLOBAL NAMESPACE (e.g. `Math.trunc`) is a
    // missing-global problem, not a string-method problem — report it with the
    // supported globals rather than falling through to the method suggestions.
    if (ts.isIdentifier(callee.expression)) {
      const ns = callee.expression.text;
      const inNamespace = Object.keys(GLOBAL_MAP).some((k) => k.startsWith(`${ns}.`));
      if (inNamespace && ns !== scope.contextVar && !scope.bound?.has(ns)) {
        throw new TranspileError(
          `Unsupported call "${callee.getText()}(...)". Supported globals: ` + `${Object.keys(GLOBAL_MAP).join(", ")}.`,
          n,
        );
      }
    }

    // `.includes` heuristic: an ARRAY-literal receiver means JS membership
    // testing → JSONata `x in [...]`. Any other receiver is treated as a string
    // and falls through to `$contains` via METHOD_MAP below.
    if (method === "includes" && ts.isArrayLiteralExpression(callee.expression)) {
      if (n.arguments.length !== 1) {
        throw new TranspileError("[...].includes(x) takes exactly one argument.", n);
      }
      const arr = emit(callee.expression, scope);
      const item = emit(n.arguments[0]!, scope);
      return `(${item} in ${arr})`;
    }

    // `.slice(start, end?)` → JSONata `$substring`. Special-cased because the
    // two-argument form needs a LENGTH, not an end index, so the args must be
    // transformed (and inspected) rather than passed straight through METHOD_MAP.
    if (method === "slice") {
      return emitSlice(n, callee, scope);
    }

    // `.substring(start, end?)` → JSONata `$substring`, with JS `.substring`'s
    // clamp-and-swap argument semantics applied at transpile time.
    if (method === "substring") {
      return emitSubstring(n, callee, scope);
    }

    // `.charAt(i)` → `$substring(s, i, 1)`. Special-cased for the literal-index
    // validation (negative / fractional literals are rejected).
    if (method === "charAt") {
      return emitCharAt(n, callee, scope);
    }

    // `.startsWith` / `.endsWith` → `$substring`-based comparisons.
    if (method === "startsWith" || method === "endsWith") {
      return emitStartsEndsWith(n, callee, method, scope);
    }

    // `.indexOf(sub)` → a `$contains` / `$substringBefore` / `$length` shim
    // (JSONata has no `$indexOf`).
    if (method === "indexOf") {
      return emitIndexOf(n, callee, scope);
    }

    // `.match(/re/)` → a projection of `$match` onto the JS `RegExpMatchArray`
    // shape (rejects the `/g` flag and non-literal patterns).
    if (method === "match") {
      return emitMatch(n, callee, scope);
    }

    if (LAMBDA_ARRAY_METHODS.has(method)) {
      return emitLambdaArrayMethod(n, callee, method, scope);
    }

    const entry = METHOD_MAP[method];
    if (entry) {
      const receiver = emit(callee.expression, scope);
      const args = n.arguments.map((a) => emit(a, scope));
      checkArity(entry, args.length, n);
      const finalArgs = entry.args(receiver, args);
      return `$${entry.jsonata}(${finalArgs.join(", ")})`;
    }

    throw new TranspileError(
      `Unsupported method ".${method}(...)". Supported methods: ` +
        `${[...Object.keys(METHOD_MAP), ...Object.keys(SPECIAL_METHOD_FORMS), "map", "filter"].join(", ")}, ` +
        "and the .length property.",
      n,
    );
  }

  throw new TranspileError("Unsupported call expression.", n);
}

/**
 * `.slice(start)` / `.slice(start, end)` → JSONata `$substring`.
 *
 * JS `.slice` takes an exclusive END index; JSONata `$substring(str, start,
 * length)` takes a LENGTH. The one-argument form needs no transformation —
 * `$substring(str, start)` reproduces `.slice(start)` for every `start`,
 * including negative ("from the end") and out-of-range indices. The
 * two-argument form is only compiled when BOTH indices are NON-NEGATIVE INTEGER
 * LITERALS, so the length `max(0, end - start)` can be computed at transpile
 * time; negative or computed indices can't be turned into a length here, so they
 * are rejected with a pointer to the raw escape hatch (a documented gap beats a
 * wrong translation).
 */
function emitSlice(n: ts.CallExpression, callee: ts.PropertyAccessExpression, scope: Scope): string {
  const receiver = emit(callee.expression, scope);

  if (n.arguments.length === 1) {
    const start = emit(n.arguments[0]!, scope);
    return `$substring(${receiver}, ${start})`;
  }

  if (n.arguments.length === 2) {
    const a0 = n.arguments[0]!;
    const a1 = n.arguments[1]!;
    // A NEGATIVE literal parses as a unary-minus expression, not a NumericLiteral,
    // so `isNumericLiteral` already excludes negatives; the integer guard rejects
    // fractional indices (e.g. `.slice(1.5, 3)`), which JS truncates but we don't.
    if (ts.isNumericLiteral(a0) && ts.isNumericLiteral(a1)) {
      const start = Number(a0.text);
      const end = Number(a1.text);
      if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= 0) {
        const length = Math.max(0, end - start);
        return `$substring(${receiver}, ${start}, ${length})`;
      }
    }
    throw new TranspileError(
      "Two-argument .slice(start, end) is only supported with non-negative integer " +
        "literal indices (it compiles to $substring(str, start, end - start)). For " +
        "computed or negative indices, use the one-argument .slice(start) or raw.jsonata.",
      n,
    );
  }

  throw new TranspileError(".slice(start, end?) takes one or two arguments.", n);
}

/**
 * `.substring(start)` / `.substring(start, end)` → JSONata `$substring`.
 *
 * JS `.substring` CLAMPS negative/NaN indices to 0 and SWAPS its arguments when
 * `start > end`; JSONata `$substring(str, start, LENGTH)` does neither (and its
 * second parameter is a length, not an end index — passing `end` straight
 * through, as a naive map would, silently returns the wrong slice). Both
 * indices must therefore be NON-NEGATIVE INTEGER LITERALS so the JS semantics
 * — start' = min(a, b), length = |b − a| — can be applied at transpile time.
 * Computed indices are rejected with a pointer at `.slice` / raw.jsonata.
 */
function emitSubstring(n: ts.CallExpression, callee: ts.PropertyAccessExpression, scope: Scope): string {
  const receiver = emit(callee.expression, scope);

  if (n.arguments.length < 1) {
    throw new TranspileError(".substring(start, end?) expects at least 1 argument(s), got 0.", n);
  }
  if (n.arguments.length > 2) {
    throw new TranspileError(`.substring(start, end?) expects at most 2 argument(s), got ${n.arguments.length}.`, n);
  }
  const literals = n.arguments.map((a) =>
    ts.isNumericLiteral(a) && Number.isInteger(Number(a.text)) ? Number(a.text) : undefined,
  );
  if (literals.some((v) => v === undefined)) {
    throw new TranspileError(
      ".substring is only supported with non-negative integer literal indices (JS " +
        ".substring clamps and SWAPS its arguments — that can't be reproduced for computed " +
        "values in $substring's start/length form). Use .slice(start) for a computed start, " +
        "or raw.jsonata.",
      n,
    );
  }
  if (literals.length === 1) {
    return `$substring(${receiver}, ${literals[0]})`;
  }
  const start = Math.min(literals[0]!, literals[1]!);
  const length = Math.abs(literals[1]! - literals[0]!);
  return `$substring(${receiver}, ${start}, ${length})`;
}

/**
 * `.charAt(i)` → JSONata `$substring(s, i, 1)` — exact for every non-negative
 * integer index, including past-the-end (both yield `""`; engine-verified).
 * A NEGATIVE literal is rejected (JSONata's `$substring` selects from the END
 * for a negative start where JS `.charAt` yields `""` — the same silent trap
 * as a negative element index); a FRACTIONAL literal is rejected too (JS
 * truncates it, `$substring` does not). A computed index is passed through —
 * it is a plain function argument (no predicate context), but a runtime-
 * negative value diverges like any computed index (see expression-support.md).
 */
function emitCharAt(n: ts.CallExpression, callee: ts.PropertyAccessExpression, scope: Scope): string {
  const receiver = emit(callee.expression, scope);
  if (n.arguments.length !== 1) {
    throw new TranspileError(".charAt(i) takes exactly one argument.", n);
  }
  const arg = unwrapParens(n.arguments[0]!);
  if (
    ts.isPrefixUnaryExpression(arg) &&
    arg.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(arg.operand)
  ) {
    throw new TranspileError(
      `.charAt(-${arg.operand.text}) is not supported: JSONata's $substring selects from the ` +
        'END of the string for a negative start, while JS .charAt yields "" — a silent divergence.',
      n,
    );
  }
  if (ts.isNumericLiteral(arg) && !Number.isInteger(Number(arg.text))) {
    throw new TranspileError(
      `.charAt(${arg.text}) requires an integer literal index (JS truncates a fractional ` +
        "index, $substring does not).",
      n,
    );
  }
  return `$substring(${receiver}, ${emit(arg, scope)}, 1)`;
}

/**
 * `.startsWith(sub)` / `.endsWith(sub)` → `$substring`-based comparisons.
 *
 * startsWith: `$substring(s, 0, len(sub)) = sub` — exact for the JS edges
 * (empty sub → always true, sub longer than s, exact length; engine-verified).
 * endsWith: `$substring(s, -len(sub)) = sub`, which is exact EXCEPT for the
 * empty sub — `$substring(s, -0)` returns the WHOLE string where JS
 * `.endsWith("")` is always true — so an empty literal folds to `true` at
 * compile time and a computed sub gets an explicit `= ""` guard.
 *
 * A literal sub's length is its CODE-POINT count (`[...sub].length`), matching
 * `$substring`/`$length`'s code-point counting so astral characters slice
 * correctly. The JS position/endPosition second argument is rejected.
 */
function emitStartsEndsWith(
  n: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  method: "startsWith" | "endsWith",
  scope: Scope,
): string {
  const receiver = emit(callee.expression, scope);
  if (n.arguments.length !== 1) {
    throw new TranspileError(
      `.${method}(searchString) takes exactly one argument — the JS ` +
        `${method === "startsWith" ? "position" : "endPosition"} second argument is not supported.`,
      n,
    );
  }
  const arg = unwrapParens(n.arguments[0]!);
  if (ts.isStringLiteralLike(arg)) {
    const sub = arg.text;
    const len = [...sub].length; // code points — $substring/$length count code points
    if (method === "startsWith") return `($substring(${receiver}, 0, ${len}) = ${quote(sub)})`;
    if (sub === "") return "true"; // JS: s.endsWith("") is always true; $substring(s, -0) is NOT
    return `($substring(${receiver}, -${len}) = ${quote(sub)})`;
  }
  const v = freshVar(scope, method === "startsWith" ? "sw" : "ew");
  const sub = emit(arg, scope);
  return method === "startsWith"
    ? `(${v} := ${sub}; $substring(${receiver}, 0, $length(${v})) = ${v})`
    : `(${v} := ${sub}; ${v} = "" or $substring(${receiver}, -$length(${v})) = ${v})`;
}

/**
 * `.indexOf(sub)` → `$contains(s, sub) ? $length($substringBefore(s, sub)) : -1`.
 *
 * JSONata has no `$indexOf`. The shim is exact for every edge JS defines: a
 * not-found search yields `-1` (the `$contains` false branch); an empty search
 * string yields `0` (`""` is contained everywhere, and `$substringBefore(s, "")`
 * is `""`, so `$length` is 0 — matching `"abc".indexOf("")` and `"".indexOf("")`);
 * a search longer than the receiver is not contained → `-1`. All engine-verified.
 *
 * The receiver and search operands are each evaluated TWICE by the shim (once in
 * `$contains`, once in `$substringBefore`/`$length`), so a non-simple operand is
 * hoisted into a temp to keep single-evaluation; a simple pure operand inlines
 * (the double lookup is provably identical) — the same temp-vs-inline rule as
 * `||`/`&&` and `.length`.
 *
 * DIVERGENCE (documented, not rejectable statically): JS `.indexOf` returns a
 * UTF-16 code-UNIT offset, while `$length`/`$substringBefore` count CODE POINTS.
 * They agree for the whole BMP; they diverge only when an ASTRAL character
 * (emoji, rare CJK) sits in the receiver BEFORE the match. That depends on
 * runtime receiver content — there is no literal to reject — so it is documented
 * as a runtime divergence (like a runtime-negative computed index), the same
 * class as the lone-surrogate note on `.startsWith`. The `fromIndex` second
 * argument is rejected (as `.startsWith` rejects its position argument).
 */
function emitIndexOf(n: ts.CallExpression, callee: ts.PropertyAccessExpression, scope: Scope): string {
  if (n.arguments.length !== 1) {
    throw new TranspileError(
      ".indexOf(searchString) takes exactly one argument — the JS fromIndex second argument is " +
        "not supported (map to raw.jsonata if you need a start offset).",
      n,
    );
  }
  // Each operand is read twice; hoist a non-simple one, inline a simple one.
  const recNode = callee.expression;
  const subNode = unwrapParens(n.arguments[0]!);
  const recSimple = isSimplePureOperand(recNode, scope);
  const subSimple = isSimplePureOperand(subNode, scope);
  const receiver = emit(recNode, scope);
  const sub = emit(subNode, scope);

  const prelude: string[] = [];
  let s = receiver;
  if (!recSimple) {
    const v = freshVar(scope, "io");
    prelude.push(`${v} := ${receiver}`);
    s = v;
  }
  let q = sub;
  if (!subSimple) {
    const v = freshVar(scope, "io");
    prelude.push(`${v} := ${sub}`);
    q = v;
  }
  const body = `$contains(${s}, ${q}) ? $length($substringBefore(${s}, ${q})) : -1`;
  return prelude.length > 0 ? `(${[...prelude, body].join("; ")})` : `(${body})`;
}

/**
 * `.match(/re/)` → a projection of JSONata's `$match` onto the JS
 * `RegExpMatchArray` shape.
 *
 * JS `String.prototype.match` WITHOUT the `/g` flag returns
 * `[fullMatch, ...captureGroups]` (with extra `.index`/`.input` props that JSON
 * ignores) or `null`; JSONata's `$match` returns `{match, index, groups}`
 * objects. The projection `$append([m.match], m.groups)` rebuilds the JS array —
 * engine-verified value-equivalent for zero groups, participating groups, and
 * NON-participating optional groups (both sides put `null` in the slot). No-match
 * is JS `null`, which the shim emits explicitly (JSONata's `$match` yields
 * MISSING, which would disagree with `null`).
 *
 * The pattern must be a REGEX LITERAL so its flags can be inspected. Only the
 * flags JSONata itself accepts — `i` and `m` — pass through; `/g` is REJECTED
 * (JS then returns bare full-match strings with no groups, a different shape),
 * and any other flag (`s`, `u`, `y`) is rejected too (JSONata's regex grammar
 * rejects them). A string or computed pattern is rejected (JS coerces a string
 * to a regex; the shim needs a literal to read the flags).
 */
function emitMatch(n: ts.CallExpression, callee: ts.PropertyAccessExpression, scope: Scope): string {
  if (n.arguments.length !== 1) {
    throw new TranspileError(".match(regexp) takes exactly one argument.", n);
  }
  const arg = unwrapParens(n.arguments[0]!);
  if (!ts.isRegularExpressionLiteral(arg)) {
    throw new TranspileError(
      ".match(regexp) is only supported with a REGEX LITERAL argument (e.g. .match(/\\d+/)) so its " +
        "flags can be checked — a string or computed pattern is not supported. Use raw.jsonata`$match(…)` " +
        "for a dynamic pattern.",
      n,
    );
  }
  // The literal text is `/pattern/flags`; split off the flags after the final `/`.
  const text = arg.text;
  const lastSlash = text.lastIndexOf("/");
  const flags = text.slice(lastSlash + 1);
  if (flags.includes("g")) {
    throw new TranspileError(
      ".match(/…/g) is not supported: with the global flag JS returns an array of the full-match " +
        "STRINGS (no capture groups), a different shape from the non-global .match this compiles. " +
        "Drop /g, or use raw.jsonata`$match(…)` (which returns every match as a {match, index, groups} object).",
      n,
    );
  }
  const badFlag = [...flags].find((f) => f !== "i" && f !== "m");
  if (badFlag !== undefined) {
    throw new TranspileError(
      `.match(/…/${flags}) uses the "${badFlag}" flag, which JSONata's regex grammar does not accept ` +
        "(only i and m are supported). Remove it, or use raw.jsonata for a hand-written match.",
      n,
    );
  }

  const receiver = emit(callee.expression, scope);
  const v = freshVar(scope, "m");
  // First match object (JS non-global .match is the first match); project to the
  // JS array shape, else the literal null JS returns for no match.
  return `(${v} := $match(${receiver}, ${text})[0]; $exists(${v}) ? $append([${v}.match], ${v}.groups) : null)`;
}

/**
 * `parseInt(s)` / `parseFloat(s)` → a lenient `$match`-extract-then-`$number`
 * shim. JS parses leniently (`parseFloat("3.7px")` → 3.7, surrounding
 * whitespace OK, `parseInt("3.7")` → 3) where bare `$number` is a strict cast
 * that THROWS on trailing garbage — so the numeric prefix is extracted with a
 * regex first. The sign is captured separately and re-applied arithmetically,
 * and a leading-dot magnitude gets a `"0"` prefix, because `$number` rejects
 * `"+42"` and `".5"` (engine-verified).
 *
 * The honest divergences (documented in expression-support.md):
 *   - no numeric prefix → JS NaN, which has no JSONata value — the shim yields
 *     MISSING (the differential harness treats NaN↔missing as agreement for
 *     these two functions only, via `nanIsMissing`);
 *   - `parseInt("0x…")` hex auto-detection → the shim parses the leading "0";
 *   - `parseFloat("Infinity")` → missing.
 * parseInt's radix argument is rejected (raw.jsonata is the escape hatch).
 */
function emitParse(n: ts.CallExpression, which: "parseInt" | "parseFloat", scope: Scope): string {
  if (which === "parseInt" && n.arguments.length === 2) {
    throw new TranspileError("parseInt's radix argument is not supported — the lenient shim always parses base 10.", n);
  }
  if (n.arguments.length !== 1) {
    throw new TranspileError(`${which}(string) takes exactly one argument.`, n);
  }
  const s = emit(n.arguments[0]!, scope);

  if (which === "parseInt") {
    const m = freshVar(scope, "pi");
    const num = freshVar(scope, "pi");
    return (
      `(${m} := $match(${s}, /^\\s*([-+]?)([0-9]+)/); ` +
      `$exists(${m}) ? (${num} := $number(${m}.groups[1]); ${m}.groups[0] = "-" ? -${num} : ${num}))`
    );
  }

  const m = freshVar(scope, "pf");
  const mag = freshVar(scope, "pf");
  const num = freshVar(scope, "pf");
  return (
    `(${m} := $match(${s}, /^\\s*([-+]?)([0-9]+(\\.[0-9]+)?|\\.[0-9]+)([eE][-+]?[0-9]+)?/); ` +
    `$exists(${m}) ? (` +
    `${mag} := ${m}.groups[1] & ($exists(${m}.groups[3]) ? ${m}.groups[3] : ""); ` +
    `${num} := $number($substring(${mag}, 0, 1) = "." ? "0" & ${mag} : ${mag}); ` +
    `${m}.groups[0] = "-" ? -${num} : ${num}))`
  );
}

/** Is the callee a `Foo.bar`-style access whose full text is a known global? */
function isQualifiedGlobal(node: ts.Expression): node is ts.PropertyAccessExpression {
  return ts.isPropertyAccessExpression(node) && node.getText() in GLOBAL_MAP;
}

/**
 * `.map(x => body)` and `.filter(x => pred)`.
 *   - filter → `[arr[$boolean(pred)]]` — the predicate is wrapped in
 *     `$boolean` so a NUMERIC predicate (`x => x.n`) tests truthiness like JS
 *     instead of becoming a JSONata INDEX lookup, and the whole thing is
 *     array-wrapped for the same singleton-flattening reason as `.map` below.
 *   - map    → `[arr.body]` when body is a single member access (path
 *              projection), else `[arr.(body)]` (object/expression projection)
 */
function emitLambdaArrayMethod(
  n: ts.CallExpression,
  callee: ts.PropertyAccessExpression,
  method: string,
  scope: Scope,
): string {
  if (n.arguments.length !== 1) {
    throw new TranspileError(`.${method}(...) takes exactly one lambda argument.`, n);
  }
  const lambda = n.arguments[0]!;
  if (!ts.isArrowFunction(lambda)) {
    throw new TranspileError(
      `.${method}(...) requires an inline arrow function, e.g. ` + `.${method}(x => x.field).`,
      lambda,
    );
  }
  if (lambda.parameters.length !== 1 || !ts.isIdentifier(lambda.parameters[0]!.name)) {
    throw new TranspileError(`.${method}(...) lambda must take exactly one simple parameter.`, lambda);
  }
  const itemVar = (lambda.parameters[0]!.name as ts.Identifier).text;
  // The item SHADOWS both the context and any same-named block binding (JS
  // lambda params shadow); other enclosing `$x` bindings remain visible
  // (JSONata variables are in scope inside projections/predicates).
  const innerScope: Scope = {
    contextVar: itemVar,
    bound: new Set([...(scope.bound ?? [])].filter((name) => name !== itemVar)),
    temps: scope.temps,
  };
  const arr = emit(callee.expression, scope);

  // A BLOCK-bodied lambda (`x => { const y = …; return …; }`) emits a JSONata
  // block scoped to the item: bindings inside SHADOW same-named outer bindings
  // for the block's extent (innermost wins, like JS) and the outer binding is
  // intact afterwards — engine-verified. The block's own parens double as the
  // projection parens: `[arr.($y := …; …)]` / `[arr[$boolean(($y := …; …))]]`.
  if (ts.isBlock(lambda.body)) {
    const block = emitBlock(lambda.body, innerScope);
    return method === "filter" ? `[${arr}[$boolean(${block})]]` : `[${arr}.${block}]`;
  }
  const body = unwrapParens(lambda.body);

  if (method === "filter") {
    // JS `.filter()` ALWAYS yields an array; JSONata `arr[pred]` yields a
    // sequence that flattens a single match to a scalar and an empty match to
    // "no value" (which DROPS the enclosing object key). The `[ ... ]` wrap
    // forces array context — 0→[], 1→[x], n→[...] — matching JS exactly.
    const pred = emit(body, innerScope);
    return `[${arr}[$boolean(${pred})]]`;
  }

  // method === "map"
  //
  // JS `.map()` ALWAYS yields an array (length === input length). JSONata's
  // projection (`arr.body`) instead returns a *sequence* that FLATTENS to a
  // scalar when it has one element (the "singleton-sequence flattening" gap).
  // We close that gap by wrapping every projection in the array constructor
  // `[ ... ]`, which forces array context: 0→[], 1→[x], n→[...]. This matches
  // JS `.map()` exactly, and downstream `$join`/`$count` still behave correctly.
  //
  // Path projection when the body is a single member/element access that starts
  // at the item context: `m => m.email` → `[arr.email]`.
  if (
    (ts.isPropertyAccessExpression(body) || ts.isElementAccessExpression(body)) &&
    !PROPERTY_FN_MAP[memberTail(body)]
  ) {
    const projected = emit(body, innerScope);
    return `[${arr}.${projected}]`;
  }
  const mapped = emit(body, innerScope);
  return `[${arr}.(${mapped})]`;
}

/** The tail member name of a property/element access, for length-detection. */
function memberTail(node: ts.Expression): string {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return "";
}

const BINARY_OPS: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.EqualsEqualsToken]: "=",
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: "=",
  [ts.SyntaxKind.ExclamationEqualsToken]: "!=",
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
  [ts.SyntaxKind.LessThanToken]: "<",
  [ts.SyntaxKind.GreaterThanToken]: ">",
  [ts.SyntaxKind.LessThanEqualsToken]: "<=",
  [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
  [ts.SyntaxKind.MinusToken]: "-",
  [ts.SyntaxKind.AsteriskToken]: "*",
  [ts.SyntaxKind.SlashToken]: "/",
  [ts.SyntaxKind.PercentToken]: "%",
};

function emitBinary(n: ts.BinaryExpression, scope: Scope): string {
  const op = n.operatorToken.kind;

  // `+`: string-ish operands → JSONata concat `&`, else numeric `+`.
  if (op === ts.SyntaxKind.PlusToken) {
    const left = emit(n.left, scope);
    const right = emit(n.right, scope);
    const operator = isStringish(n.left) || isStringish(n.right) ? "&" : "+";
    return `(${left} ${operator} ${right})`;
  }

  // `a || b` / `a && b` must PRESERVE THE VALUE like JS (JSONata's `or`/`and`
  // return booleans, so `name or "unknown"` would emit `true`). The left value
  // is evaluated TWICE by the `$boolean(x) ? x : …` selection, so a temp stashes
  // it — UNLESS it is a simple pure operand, where the double evaluation is
  // provably identical and the temp is pure noise; then we inline it. The one
  // divergence is $boolean's truthiness for `[]`/`{}`/`[0]` (JSONata-falsy,
  // JS-truthy); see expression-support.md.
  if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
    const isOr = op === ts.SyntaxKind.BarBarToken;
    const left = emit(n.left, scope);
    // Allocate the temp — in the SAME position as before (between the two
    // operands, so remaining temp numbers are unchanged) — ONLY when the left is
    // not simple. A simple left inlines to a repeated, side-effect-free lookup.
    const inline = isSimplePureOperand(n.left, scope);
    const v = inline ? undefined : freshVar(scope, isOr ? "or" : "and");
    const right = emit(n.right, scope);
    if (v === undefined) {
      // Inlined: `left` is repeated verbatim (mind the branch order).
      return isOr ? `($boolean(${left}) ? ${left} : ${right})` : `($boolean(${left}) ? ${right} : ${left})`;
    }
    return isOr
      ? `(${v} := ${left}; $boolean(${v}) ? ${v} : ${right})`
      : `(${v} := ${left}; $boolean(${v}) ? ${right} : ${v})`;
  }

  // Equality against `undefined`/`null` maps to JSONata EXISTENCE checks where
  // needed: a missing key compares as FALSE to everything in JSONata (even
  // `= null`), which would silently break `x === undefined` for absent keys.
  const nullish = emitNullishComparison(n, scope);
  if (nullish !== undefined) return nullish;

  const mapped = BINARY_OPS[op];
  if (!mapped) {
    const hint =
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ? " Use `||` (value-preserving here) or an explicit `x === undefined ? y : x` ternary."
        : "";
    throw new TranspileError(`Unsupported binary operator "${n.operatorToken.getText()}".${hint}`, n);
  }
  const left = emit(n.left, scope);
  const right = emit(n.right, scope);
  // Always parenthesize to preserve precedence regardless of context.
  return `(${left} ${mapped} ${right})`;
}

/**
 * Equality comparisons against the `undefined` identifier or the `null`
 * literal. JS distinguishes null from undefined (absent); JSONata's `x = null`
 * only matches PRESENT null values, so each form gets its own emission —
 * verified against the engine for all of {missing, null, value}:
 *
 *   x === undefined  →  $not($exists(x))
 *   x !== undefined  →  $exists(x)
 *   x == null/undefined  →  ($not($exists(x)) or x = null)     [nullish]
 *   x != null/undefined  →  ($exists(x) and x != null)
 *   x === null       →  (x = null)                              [as-is]
 *   x !== null       →  ($not($exists(x)) or x != null)
 *
 * Returns undefined when the comparison doesn't involve null/undefined.
 */
function emitNullishComparison(n: ts.BinaryExpression, scope: Scope): string | undefined {
  const op = n.operatorToken.kind;
  const strictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const strictNe = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const looseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const looseNe = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!strictEq && !strictNe && !looseEq && !looseNe) return undefined;

  const kindOf = (e: ts.Expression): "undefined" | "null" | undefined => {
    const u = unwrapParens(e);
    if (u.kind === ts.SyntaxKind.NullKeyword) return "null";
    if (isUndefinedLiteral(u, scope)) return "undefined";
    return undefined;
  };
  const leftKind = kindOf(n.left);
  const rightKind = kindOf(n.right);
  if (leftKind === undefined && rightKind === undefined) return undefined;
  // Compare the OTHER side against the nullish literal (either operand order).
  const literal = rightKind ?? leftKind;
  const operand = rightKind !== undefined ? n.left : n.right;
  const x = emit(operand, scope);

  if (strictEq) return literal === "undefined" ? `$not($exists(${x}))` : `(${x} = null)`;
  if (strictNe) return literal === "undefined" ? `$exists(${x})` : `($not($exists(${x})) or ${x} != null)`;
  if (looseEq) return `($not($exists(${x})) or ${x} = null)`;
  return `($exists(${x}) and ${x} != null)`;
}

/** Heuristic: does this node look like a string at authoring time? */
function isStringish(node: ts.Expression): boolean {
  const n = unwrapParens(node);
  if (ts.isStringLiteral(n)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (ts.isTemplateExpression(n)) return true;
  // A `+` whose either side is string-ish is itself string-ish.
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isStringish(n.left) || isStringish(n.right);
  }
  return false;
}

function emitUnary(n: ts.PrefixUnaryExpression, scope: Scope): string {
  if (n.operator === ts.SyntaxKind.ExclamationToken) {
    // Minifier idiom: `!0`→true / `!1`→false (see shared.foldMinifiedBoolean).
    const folded = foldMinifiedBoolean(n);
    if (folded) return folded;
    return `$not(${emit(n.operand, scope)})`;
  }
  const operand = emit(n.operand, scope);
  if (n.operator === ts.SyntaxKind.MinusToken) {
    return `-${operand}`;
  }
  if (n.operator === ts.SyntaxKind.PlusToken) {
    // Unary plus → numeric coercion; JSONata has no `+x`, use $number.
    return `$number(${operand})`;
  }
  throw new TranspileError(`Unsupported unary operator "${ts.tokenToString(n.operator) ?? n.operator}".`, n);
}

function emitConditional(n: ts.ConditionalExpression, scope: Scope): string {
  const cond = emit(n.condition, scope);
  const whenTrue = emit(n.whenTrue, scope);
  const whenFalse = emit(n.whenFalse, scope);
  return `(${cond} ? ${whenTrue} : ${whenFalse})`;
}

/** Template literal `` `a${x}b` `` → `("a" & x & "b")`. */
function emitTemplate(n: ts.TemplateExpression, scope: Scope): string {
  const parts: string[] = [];
  if (n.head.text !== "") parts.push(quote(n.head.text));
  for (const span of n.templateSpans) {
    // Wrap the interpolated expression so concat binds correctly; $string-cast
    // is NOT applied (JSONata `&` coerces operands to strings already).
    parts.push(`(${emit(span.expression, scope)})`);
    if (span.literal.text !== "") parts.push(quote(span.literal.text));
  }
  if (parts.length === 0) return quote("");
  if (parts.length === 1) {
    // Single interpolation with empty head/tail: still coerce to string via &"".
    return `(${parts[0]} & "")`;
  }
  return `(${parts.join(" & ")})`;
}

/** Validate call arity against the function map entry. */
function checkArity(entry: FnMapEntry, count: number, at: ts.Node): void {
  if (entry.minArgs !== undefined && count < entry.minArgs) {
    throw new TranspileError(`${entry.label} expects at least ${entry.minArgs} argument(s), got ${count}.`, at);
  }
  if (entry.maxArgs !== undefined && count > entry.maxArgs) {
    throw new TranspileError(`${entry.label} expects at most ${entry.maxArgs} argument(s), got ${count}.`, at);
  }
}

// Re-export the shared quote helper (historical import site for tests/index).
export { quote };
