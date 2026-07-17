// The curated TS/JS → JSONata function map.
//
// This is the SINGLE, documented table the transpiler consults when it sees a
// method call (`x.foo(...)`) or a supported global call (`String(x)`,
// `Math.round(x)`, ...). Keeping it here — one entry per supported function —
// makes the supported surface auditable and trivial to extend: add a row, add a
// test, done.
//
// JSONata's string/array functions take the "subject" as their FIRST argument,
// whereas in JS it's the receiver (`subject.method(args)`). Each entry says how
// to assemble the final `$fn(...)` argument list from the receiver + call args.

/** How a JS call maps onto a JSONata `$function(...)` invocation. */
export interface FnMapEntry {
  /** The JSONata function name, without the leading `$`. */
  readonly jsonata: string;
  /**
   * Build the JSONata argument list (already-transpiled strings) from the
   * receiver expression and the transpiled call arguments.
   *
   * For a *method* (`subject.method(a, b)`) `receiver` is the transpiled
   * subject and is usually prepended: `$fn(subject, a, b)`.
   *
   * For a *global* (`String(x)`) `receiver` is undefined and only `args` are
   * used.
   */
  readonly args: (receiver: string | undefined, args: string[]) => string[];
  /** Min number of *call* arguments (excludes the receiver). */
  readonly minArgs?: number;
  /** Max number of *call* arguments, or undefined for unbounded. */
  readonly maxArgs?: number;
  /** Human label for error messages, e.g. ".toUpperCase()". */
  readonly label: string;
}

/** Prepend the receiver, then the call args: `$fn(subject, ...args)`. */
const receiverFirst = (receiver: string | undefined, args: string[]): string[] =>
  receiver === undefined ? args : [receiver, ...args];

/**
 * Prepend the receiver, then the call args, but NEGATE the first call arg:
 * `$fn(subject, -(arg0), ...rest)`. Used by `.padStart`, which pads on the LEFT
 * — JSONata's `$pad` expresses left-padding with a NEGATIVE width (a positive
 * width pads on the right). Wrapping in `-(…)` works for both a literal width
 * (`-(8)`) and a path expression (`-(parameters.width)`).
 */
const receiverFirstNegateFirstArg = (receiver: string | undefined, args: string[]): string[] =>
  receiver === undefined ? args : [receiver, `-(${args[0]})`, ...args.slice(1)];

/**
 * Method-name → mapping. Keyed by the JS method identifier (`toUpperCase`,
 * `join`, ...). The `.length` PROPERTY lives in `PROPERTY_FN_MAP` below;
 * `.slice`/`.substring` are special-cased in transpile.ts (arg transforms).
 */
export const METHOD_MAP: Record<string, FnMapEntry> = {
  // A bare `.join()` defaults the separator to "," in JS, but `$join(arr)`
  // joins with "" — so the JS default is injected explicitly. NOTE: `$join`
  // THROWS on non-string elements where JS coerces them (documented gap).
  join: {
    jsonata: "join",
    args: (receiver, args) => (receiver === undefined ? args : [receiver, args[0] ?? '","']),
    minArgs: 0,
    maxArgs: 1,
    label: ".join(sep?)",
  },
  toUpperCase: {
    jsonata: "uppercase",
    args: receiverFirst,
    minArgs: 0,
    maxArgs: 0,
    label: ".toUpperCase()",
  },
  toLowerCase: {
    jsonata: "lowercase",
    args: receiverFirst,
    minArgs: 0,
    maxArgs: 0,
    label: ".toLowerCase()",
  },
  trim: {
    jsonata: "trim",
    args: receiverFirst,
    minArgs: 0,
    maxArgs: 0,
    label: ".trim()",
  },
  // `.substring` is NOT mapped here: JS `.substring(start, end)` takes an END
  // index (with clamp-and-swap semantics) while `$substring` takes a LENGTH, so
  // the args must be transformed — the transpiler special-cases it (like
  // `.slice`) in emitSubstring.
  //
  // `.includes` is OVERLOADED by JS receiver type, so it is resolved by a
  // heuristic in transpile.ts BEFORE this table is consulted:
  //   - ARRAY-literal receiver  `["a","b"].includes(x)` → membership `x in [...]`
  //   - everything else (string) `s.includes(sub)`       → `$contains(s, sub)`
  // This entry is the string-receiver fallback.
  includes: {
    jsonata: "contains",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: ".includes(substr)",
  },
  // `a.concat(b)` (array concat) → `$append(a, b)`. JSONata's `$append` is
  // strictly binary, so only a single argument is supported; for more, chain
  // `.concat(...).concat(...)`.
  concat: {
    jsonata: "append",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: ".concat(arr)",
  },
  split: {
    jsonata: "split",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 2,
    label: ".split(sep)",
  },
  // JS `.replace(string, string)` replaces only the FIRST occurrence; bare
  // `$replace` replaces ALL. `$replace`'s optional 4th argument is a LIMIT, so
  // `.replace` pins it to 1 and `.replaceAll` leaves it unbounded. NOTE: JS
  // replacement patterns (`$&`, `$$`, ...) are NOT interpreted by `$replace`
  // for string patterns — they stay literal (documented gap).
  replace: {
    jsonata: "replace",
    args: (receiver, args) => (receiver === undefined ? args : [receiver, ...args, "1"]),
    minArgs: 2,
    maxArgs: 2,
    label: ".replace(pattern, replacement)",
  },
  replaceAll: {
    jsonata: "replace",
    args: receiverFirst,
    minArgs: 2,
    maxArgs: 2,
    label: ".replaceAll(pattern, replacement)",
  },
  // `.padStart(targetLength, padString?)` / `.padEnd(...)` → JSONata `$pad`.
  // `$pad(str, width, char?)` pads to `abs(width)` total chars: a POSITIVE width
  // pads on the RIGHT (≡ padEnd), a NEGATIVE width pads on the LEFT (≡ padStart).
  // So padEnd passes the width through unchanged, while padStart negates it.
  // The optional pad string maps straight to `$pad`'s `char` (multi-char padding
  // and the default-space behaviour both match JS — verified differentially).
  padStart: {
    jsonata: "pad",
    args: receiverFirstNegateFirstArg,
    minArgs: 1,
    maxArgs: 2,
    label: ".padStart(targetLength, padString?)",
  },
  padEnd: {
    jsonata: "pad",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 2,
    label: ".padEnd(targetLength, padString?)",
  },
};

/**
 * How a JS PROPERTY access maps onto a JSONata emission. Unlike an
 * `FnMapEntry`, a property mapping owns its whole emission: `.length` needs a
 * type-dispatching shim (not a single `$fn` call), so the entry receives the
 * emitted receiver plus a fresh-temp allocator and returns the fragment.
 */
export interface PropertyFnEntry {
  /** Human label for error messages/docs, e.g. ".length". */
  readonly label: string;
  /**
   * Emit the JSONata for `<receiver>.<prop>`. `fresh(kind)` allocates a
   * collision-safe temp variable; `simple` is true when the receiver is a simple
   * pure operand (a variable/path/literal), so a shim that would otherwise stash
   * it in a temp to avoid double evaluation may repeat it inline instead.
   */
  readonly emit: (receiver: string, fresh: (kind: string) => string, simple: boolean) => string;
}

/**
 * Property-name → mapping for accessors that are *properties* in JS but
 * *functions* in JSONata.
 *
 * `.length` is JS-overloaded: string length AND array length. JSONata splits
 * those across `$length` (strings) and `$count` (arrays) — and `$count` of a
 * string is 1, so a single-function map would silently break one of the two.
 * The emission captures the receiver in a temp and dispatches on `$type`,
 * which is exact for both (verified differentially). For a MISSING receiver
 * the shim yields 0 where JS would throw a TypeError (documented gap).
 *
 * DEVIATION from the spec table: `.count` is intentionally NOT mapped here.
 * JavaScript has no `Array.prototype.count`, so a `.count` in author code is
 * almost always a plain DATA field (e.g. `c.parameters.count`). Mapping it to
 * `$count(...)` would silently mistranslate that field. We therefore treat
 * `.count` as a normal path step and only special-case the JS-real `.length`.
 * For an explicit element count, authors can write `.length` or use
 * `raw.jsonata\`$count(...)\``.
 */
export const PROPERTY_FN_MAP: Record<string, PropertyFnEntry> = {
  length: {
    label: ".length",
    emit: (receiver, fresh, simple) => {
      // A simple pure receiver is repeated inline; anything else is stashed in a
      // temp so it evaluates once (cost + nondeterminism safety).
      if (simple) {
        return `($type(${receiver}) = "string" ? $length(${receiver}) : $count(${receiver}))`;
      }
      const v = fresh("len");
      return `(${v} := ${receiver}; $type(${v}) = "string" ? $length(${v}) : $count(${v}))`;
    },
  },
};

/**
 * Global-function → mapping, keyed by the *fully qualified* JS callee text:
 * `String`, `Number`, `Boolean`, and `Math.round` etc.
 */
export const GLOBAL_MAP: Record<string, FnMapEntry> = {
  // `assert(cond, msg)` → `$assert(cond, msg)`. Recognised as a free function so
  // block-bodied procedural expressions can guard preconditions. The author-side
  // runtime mirror (`assert` exported from the package) throws `Error(msg)` when
  // `cond` is false — matching the message JSONata's `$assert` raises — so the
  // differential harness exercises BOTH sides, including the throwing cases.
  assert: {
    jsonata: "assert",
    args: receiverFirst,
    minArgs: 2,
    maxArgs: 2,
    label: "assert(condition, message)",
  },
  // `require(cond, msg)` — ADR-0025 §5's preferred v2 spelling of `assert`, read
  // as a sentence ("require the manager to be resolved, or fail"). Maps to the
  // SAME `$assert` JSONata target with the SAME arity, so `require(...)` and
  // `assert(...)` transpile byte-identically — a separate map key (not an alias
  // loop) so an unsupported-call error lists both names. The runtime mirror
  // (`require`, exported from expr/jsonata/index.ts) delegates to `assert`
  // verbatim, so the differential harness exercises both sides identically.
  require: {
    jsonata: "assert",
    args: receiverFirst,
    minArgs: 2,
    maxArgs: 2,
    label: "require(condition, message)",
  },
  // `substringAfter(str, chars)` / `substringBefore(str, chars)` →
  // `$substringAfter(...)` / `$substringBefore(...)`. Recognised as free
  // functions (like `assert`) so e.g. `substringAfter(c.ref, "user:default/")`
  // compiles directly. The package exports matching JS oracles for differential.
  substringAfter: {
    jsonata: "substringAfter",
    args: receiverFirst,
    minArgs: 2,
    maxArgs: 2,
    label: "substringAfter(str, chars)",
  },
  substringBefore: {
    jsonata: "substringBefore",
    args: receiverFirst,
    minArgs: 2,
    maxArgs: 2,
    label: "substringBefore(str, chars)",
  },
  String: {
    jsonata: "string",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "String(x)",
  },
  Number: {
    jsonata: "number",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Number(x)",
  },
  Boolean: {
    jsonata: "boolean",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Boolean(x)",
  },
  "Math.round": {
    jsonata: "round",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Math.round(x)",
  },
  "Math.floor": {
    jsonata: "floor",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Math.floor(x)",
  },
  "Math.ceil": {
    jsonata: "ceil",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Math.ceil(x)",
  },
  "Math.abs": {
    jsonata: "abs",
    args: receiverFirst,
    minArgs: 1,
    maxArgs: 1,
    label: "Math.abs(x)",
  },
};

/**
 * Array methods that take a *lambda* and translate to JSONata syntax rather
 * than a `$fn` call: `.map` → projection, `.filter` → predicate. Listed here so
 * the transpiler can recognise and reject them with a helpful message if the
 * arity is wrong, while keeping the "supported surface" in one place.
 */
export const LAMBDA_ARRAY_METHODS = new Set(["map", "filter"]);

/**
 * METHOD calls the transpiler SPECIAL-CASES in transpile.ts (argument
 * transforms / literal validation that a plain `FnMapEntry` cannot express),
 * keyed by method name → why it isn't a map row. Like `METHOD_MAP`, every key
 * here must carry an engine-verified case in `fnmap.differential.test.ts` —
 * the completeness test enforces key-set equality, so a special form cannot be
 * added with unverified semantics.
 */
export const SPECIAL_METHOD_FORMS: Record<string, string> = {
  slice: "two-arg form computes a LENGTH from literal indices ($substring takes length, not end)",
  substring: "JS clamp-and-swap argument semantics are applied at transpile time",
  charAt: "rejects negative/fractional literal indices before mapping to $substring(s, i, 1)",
  startsWith: "emits a $substring prefix comparison (with a hoist for a computed search string)",
  endsWith: "emits a $substring suffix comparison with the JS empty-string guard",
  indexOf: "no $indexOf — a $contains/$substringBefore/$length shim (rejects the fromIndex argument)",
  match:
    "projects $match's {match,index,groups} onto the JS RegExpMatchArray shape (rejects /g and non-literal patterns)",
};

/**
 * GLOBAL calls the transpiler SPECIAL-CASES in transpile.ts, with the same
 * completeness contract as `SPECIAL_METHOD_FORMS`.
 */
export const SPECIAL_GLOBAL_FORMS: Record<string, string> = {
  parseInt: "lenient $match-extract-then-$number shim (bare $number is a strict cast)",
  parseFloat: "lenient $match-extract-then-$number shim (bare $number is a strict cast)",
};
