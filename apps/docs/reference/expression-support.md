# Expression support

What TypeScript the two transpilers accept, and where the gaps are.

The source of truth is the code, not this page. It is the curated maps and tests in
`packages/core/src/expr/jsonata/` and `packages/core/src/expr/nunjucks/` — the
`METHOD_MAP`, `GLOBAL_MAP` and `PROPERTY_FN_MAP` plus the `*.test.ts` files. This
reference tracks them. Every `METHOD_MAP`/`GLOBAL_MAP` row is engine-verified by the
mechanical differential suite (`fnmap.differential.test.ts`): a row cannot be added
without a case. Anything unsupported throws a `TranspileError` / `NjTranspileError`
at compile — use the `raw` escape hatch (`` raw.jsonata`…` `` or
<code v-pre>raw`${{ … }}`</code>) for it.

Legend:

- ✅ supported
- 🔧 closeable — a real equivalent exists, just not mapped yet
- 🔒 intentional — out of scope by design
- ❌ unsupported — no clean equivalent, use `raw`

## `jsonata()` — TS to JSONata (rich)

### Emission formatting — pretty by default

Compiled expressions are pretty-printed: long blocks put each `$x := …;` statement on
its own line (closing paren aligned), long ternaries put each branch on its own line,
and long object or array constructors split member-per-line — all 2-space indented.
Short expressions (≤ about 60 chars) stay single-line, so `(a or b)`-scale output
gains no noise. JSONata is whitespace-insensitive and the `yaml` package renders the
multi-line strings as block scalars, so compiled artifacts stay valid and diff
cleanly.

- `JsonataExpr.jsonata` is the pretty emission (what ships by default, what
  `validateJsonata` parsed, and what the differential harness evaluates);
  `JsonataExpr.compact` is the canonical single-line form.
- The accessor you read is the one layout control, baked at build time: use
  `.jsonata` for the pretty (multi-line) form, `.compact` for the single-line one —
  for example a roadie step's `expression: someExpr.compact`. There is no
  target-level or CLI-level override; whichever accessor the template reads is what
  ships.
- `raw.jsonata` strings are never reformatted (hand-written formatting is preserved),
  and `nj()` emissions are always single-line — they live inside <code v-pre>${{ … }}</code>
  interpolations where multi-line adds risk without benefit.

### Supported constructs

| TS construct | | Maps to / note |
|---|---|---|
| `===`/`==`, `!==`/`!=`, `< > <= >=` | ✅ | `=`, `!=`, pass-through. Comparisons against `undefined`/`null` compile to `$exists` forms that are exact for **missing / null / present** (e.g. `x === undefined` → `$not($exists(x))`, loose `x == null` → `($not($exists(x)) or x = null)`) |
| `&&` `\|\|` `!` | ✅ | **value-preserving** — JSONata's own `or`/`and` return *booleans*, which would turn `c.name \|\| "?"` into `true`, so a `$boolean(x) ? x : y` conditional is emitted instead. When the left operand is a **simple pure operand** (a variable, path, or literal) it is **inlined**: `c.name \|\| "?"` → `($boolean(name) ? name : "?")`, `c.a && c.b` → `($boolean(a) ? b : a)`. When it is anything else (**any call**), a temp stashes it so it evaluates once: `c.tags.join() \|\| "?"` → `($__or1 := $join(tags, ","); $boolean($__or1) ? $__or1 : "?")`. In a `\|\| \|\| ` chain the outer left is a conditional (not simple), so it keeps its temp. `!` → `$not()`. Truthiness is `$boolean`'s — see **Semantic divergences** |
| `+ - * / %` | ✅ | `+` is `&` (concat) when stringish, else numeric |
| ternary `c ? a : b` | ✅ | |
| object / array literals | ✅ | incl. `[...a, x]` → `$append` |
| template literals `` `a${x}` `` | ✅ | → `&` concat |
| member access `c.a.b`, optional chaining `c.a?.b` | ✅ | both emit the path `a.b` — JSONata paths already propagate a missing base, which is exactly `?.` (prefer `?.` when a parent may be absent; see divergences) |
| string-key access `c.x["k"]`, `c.steps["fetch-base"]` | ✅ | non-identifier keys become **backtick steps**: `` steps.`fetch-base` `` (a bare `steps.fetch-base` would parse as subtraction). Keys containing a backtick are rejected (unescapable) |
| index access `c.l[0]`, `c.l[c.i]` | ✅ | a **computed** index is hoisted so it evaluates in the enclosing scope — `($__idx1 := i; list[$__idx1])` — because a bare `list[i]` is a JSONata *predicate* evaluated per-item. **Negative literal** indices are rejected (`list[-1]` selects from the END in JSONata, `undefined` in JS — a silent trap); use `.slice(-n)` or `raw.jsonata` |
| block body: `const`/`let`, reassignment, `return`, bare `assert(...)` | ✅ | `$x := …`; statement layer. Assigning to an **undeclared** name is rejected (strict-mode JS would ReferenceError) |
| `.map`/`.filter` | ✅ | `.map(x => e)` → `[arr.e]`; `.filter(x => p)` → `[arr[$boolean(p)]]` — the `$boolean` makes numeric predicates test *truthiness* (a bare numeric predicate is an INDEX in JSONata), and the `[…]` wrap keeps 0/1-match results array-shaped like JS. Lambda params shadow same-named block bindings and the context param, like JS. Block-bodied lambdas are supported (see below) |
| `.join .concat .split .length` | ✅ | `$join $append $split`. Bare `.join()` injects the JS default `","` (bare `$join` uses `""`). `.length` emits a `$type`-dispatching shim — exact for **both** strings and arrays (`$count(str)` alone is 1 for any string). A **simple pure receiver** is inlined: `c.members.length` → `($type(members) = "string" ? $length(members) : $count(members))`; a **call** receiver keeps a temp so it evaluates once: `c.a.concat(c.b).length` → `($__len1 := $append(a, b); $type($__len1) = "string" ? $length($__len1) : $count($__len1))` |
| `.toUpperCase .toLowerCase .trim .includes` | ✅ | `$uppercase $lowercase $trim $contains` |
| `.replace .replaceAll` | ✅ | `.replace` → `$replace(s, a, b, 1)` (JS replaces the FIRST occurrence for string patterns; bare `$replace` replaces ALL); `.replaceAll` → unlimited `$replace`. JS replacement patterns (`$&`, `$$`) are NOT interpreted — see divergences |
| `.substring(start, end?)` | ✅ | **literal indices only** — JS `.substring` clamps negatives to 0 and SWAPS `start > end`, while `$substring` takes a *length*; the transpiler applies `start' = min(a,b)`, `length = \|b−a\|` at compile time. Computed/negative indices throw → use `.slice(start)` or `raw.jsonata` |
| `String/Number/Boolean`, `Math.{round,floor,ceil,abs}`, `assert`, `substringAfter`/`substringBefore` | ✅ | `$string …` etc. — edge divergences (Number(""), Boolean([]), Math.round halves) below |
| `.slice .padStart .padEnd` | ✅ | `$substring` / `$pad`. `.padEnd(n,ch)`→`$pad(s, n, ch)`, `.padStart(n,ch)`→`$pad(s, -(n), ch)` (negative width = left-pad). `.slice(start)` is fully general; `.slice(start, end)` only for **non-negative integer-literal** indices (→ `$substring(s, start, max(0, end−start))`) — computed/negative two-arg `.slice` throws → use `raw` |
| `.charAt(i)` | ✅ | `$substring(s, i, 1)` — exact incl. past-the-end (both `""`). **Negative/fractional literals rejected** ($substring selects from the END for negatives; JS truncates fractions). Computed index passes through — a runtime-negative diverges (see divergences) |
| `.startsWith .endsWith` | ✅ | `$substring` prefix/suffix comparisons, exact for the JS edges (empty search string → always `true`, longer-than-receiver, exact-length; engine-verified). `.endsWith("")` folds to `true` at compile ( `$substring(s, -0)` would return the whole string); a computed search string hoists into a temp with an `= ""` guard. Literal lengths count **code points**, matching `$substring` — astral-safe. The JS position/endPosition second arg is rejected |
| `parseInt(s) parseFloat(s)` | ✅ | **lenient shims**, not plain `$number` (a strict cast that throws on trailing garbage): `$match`-extract the numeric prefix, then `$number` (sign re-applied arithmetically; leading-dot magnitudes get a `"0"` prefix — `$number` rejects `"+42"`/`".5"`). `parseFloat("3.7px")` → 3.7, whitespace OK, `parseInt("3.7")` → 3. **No numeric prefix → missing, not NaN** (see divergences). `parseInt`'s radix argument is rejected → `raw.jsonata` |
| `.indexOf(sub)` | ✅ | JSONata has no `$indexOf`; compiles to `($contains(s, sub) ? $length($substringBefore(s, sub)) : -1)` — exact for not-found (`-1`), found-at-0, empty search (`"abc".indexOf("")` → 0), and search-longer-than-receiver. Simple operands inline; a call receiver/arg hoists into a temp. The `fromIndex` second argument is rejected. **Astral divergence** below (JS counts UTF-16 units, the shim counts code points) |
| `.match(/re/)` | ✅ | projects `$match`'s `{match, index, groups}` onto the JS `RegExpMatchArray` — `($m := $match(s, /re/)[0]; $exists($m) ? $append([$m.match], $m.groups) : null)` — value-equivalent for the full match + capture groups (participating and non-participating slots both `null`), with a literal `null` on no match. **Regex-literal argument only** so flags can be checked: `i`/`m` pass through; `/g` is rejected (JS then returns bare full-match strings — a different shape), other flags (`s`/`u`/`y`) are rejected (JSONata's grammar rejects them). A string/computed pattern is rejected → use `raw.jsonata` |
| `.map`/`.filter` with a **block-bodied** lambda | ✅ | `.map(x => { const y = …; return …; })` → a per-item JSONata block `[arr.($y := …; …)]` (filter: wrapped in `$boolean`). Bindings SHADOW same-named outer bindings for the block's extent and the outer binding survives — innermost wins, like JS (engine-verified) |
| `if`/`for`/`while`/`switch`/`try` | 🔒 | expression language — use ternary + `.map`/`.filter`/`.reduce` |
| object spread `{ ...a, b: 1, ...c }` | ✅ | → `$merge([a, {"b": 1}, c])`, preserving interleaving order; **later keys win on both sides** (engine-verified). Spread of a *missing* value contributes nothing, like JS `{...undefined}` (the array constructor drops the member). Spread of a present `null` / non-object diverges — see divergences |
| destructuring, computed non-literal keys | 🔒 | destructuring 🔒; computed keys 🔧 if needed |
| `typeof instanceof new this`, bitwise, `++ --` | 🔒 | not meaningful in JSONata |
| `JSON.*`, `Date`, arbitrary globals | ❌ | no clean equivalent — use `raw.jsonata` |

### Semantic divergences (JS oracle vs the JSONata engine)

These are the cases where a *supported* construct evaluates differently in the two
worlds. The differential harness surfaces every one of them; the fixtures in TDK's
own tests stay inside the agreeing domain.

- **`$boolean` truthiness.** `[]`, `{}`, and all-falsy arrays like `[0]` are
  **falsy** to `$boolean` but truthy in JS. This affects `||`/`&&`, `!`, ternary
  conditions, `.filter` predicates, and `Boolean(x)`. Strings/numbers/null/missing
  agree with JS (`"0"` is truthy in both, `""`/`0` falsy).
- **Missing-parent access.** `c.a.b` with `a` absent *propagates* to missing in
  JSONata but **throws** in JS — so the oracle and engine disagree on plain access.
  Write `c.a?.b` (same emission, and the JS side then agrees).
- **`.length` of a missing value** yields `0` in the emitted shim; JS throws a
  TypeError. (Same root cause as above — guard with `?.` if it matters.)
- **Runtime-negative computed indices.** `c.list[c.i]` with `i = -1` at runtime
  selects from the END in JSONata, `undefined` in JS. (Negative *literals* are
  rejected at compile time.) The same applies to `.charAt(c.i)` with a
  runtime-negative `i` — `$substring` selects from the end, JS yields `""`.
- **`parseInt`/`parseFloat` with no parseable prefix** yield **missing** where JS
  yields `NaN` (JSONata has no NaN value). This is the documented agreement the
  differential harness's `nanIsMissing` option encodes — for these two functions
  ONLY. Two smaller edges: `parseInt("0x1A")` parses the leading `0` (JS auto-detects
  hex → 26), and `parseFloat("Infinity")` is missing (JS yields `Infinity`).
- **TDZ inside block lambdas.** Reading a name before its own `const` shadows an
  outer binding (`const t = 1; items.map(x => { const b = t; const t = …`) is a JS
  ReferenceError but evaluates silently in JSONata (the outer `$t` is visible until
  the inner `:=`). Don't shadow across a read.
- **Lone-surrogate literals** in `.startsWith`/`.endsWith` (e.g. `"\uD83C"`, half of
  an emoji) compare by UTF-16 unit in JS but by code point in JSONata — they diverge.
  Use whole characters.
- **`.indexOf` past an astral character.** JS `.indexOf` returns a UTF-16 code-*unit*
  offset; the `$length`/`$substringBefore` shim counts code *points*. They agree
  across the whole BMP and diverge only when an astral character (emoji, rare CJK)
  sits in the receiver *before* the match — `"🎂x".indexOf("x")` is `2` in JS, `1` in
  the shim. This depends on runtime receiver content (no literal to reject at
  compile), so it is a documented runtime divergence, like a runtime-negative
  computed index.
- **Object spread of a present `null` or a non-object** throws in JSONata (`$merge`
  requires objects) where JS yields `{}` (for `null`) or spreads the
  characters/indices. Spread of a *missing* value agrees (both contribute nothing).
- **`+` on runtime strings.** `c.a + c.b` emits numeric `+` unless an operand is
  *statically* stringish (literal/template/`.trim()` etc., which emit `&`). Two
  runtime strings therefore **throw** in JSONata where JS concatenates. Use a
  template literal for concatenation.
- **`Number("")`** throws in JSONata (`$number` is a strict cast); JS gives `0`.
- **`String(object)`** emits JSON (`{"a":1}`); JS gives `[object Object]`.
- **`Math.round` on exact halves** — `$round` is half-to-EVEN (`$round(2.5)` = 2); JS
  `Math.round` rounds half up (3). Non-half values agree.
- **Template-literal interpolation of a missing value** renders `""` in JSONata (`&`
  treats missing as empty); JS renders the string `"undefined"`.
- **`.replace` replacement patterns.** `$&`/`$$` etc. are NOT interpreted by
  `$replace` for string patterns — they are inserted literally.
- **`$join` on non-string arrays** throws (`.join` on `[1, 2]`); JS coerces each
  element. Map to strings first: `.map(x => String(x)).join(...)`.
- **Nested `.map` returning an array per item.** JSONata sequences flatten nested
  arrays — `orders.map(o => o.items.map(i => i.name))` yields the flattened name
  list, not an array of arrays (verified: no `$map`/`.[...]` phrasing preserves the
  singleton case either). Nested maps whose inner body REDUCES to a scalar
  (`.join(...)`, `.length`) agree with JS. For a true nested shape use `raw.jsonata`
  with explicit object wrapping.

## `nj()` — TS to Nunjucks (intentionally minimal)

`nj` targets the restricted Nunjucks expression inside Scaffolder <code v-pre>${{ … }}</code> —
value access, defaults, and simple casing. It is not for logic. Every compiled
expression is validated with the real Nunjucks engine at build time (eager compile
for syntax and an empty-context render for filter resolution), mirroring the JSONata
backend's parse-validation.

What Scaffolder <code v-pre>${{ }}</code> accepts is verified. Backstage's `SecureTemplater`
(`plugins/scaffolder-backend/src/lib/templating/SecureTemplater.ts`) configures stock
nunjucks with <code v-pre>variableStart: '${{'</code> / <code v-pre>variableEnd: '}}'</code> and `autoescape: false`;
it sandboxes only the runtime (isolated-vm) and adds filters — it does not restrict
the expression parser. Core-grammar constructs (comparisons, arithmetic, `~`
concatenation, method calls on values) are therefore available inside
<code v-pre>${{ }}</code>, and the same stock engine drives both `validateNunjucks` and the
differential harness here.

### Supported constructs

| TS construct | | Maps to / note |
|---|---|---|
| member/index access `c.parameters.x`, `c.steps["id"].output.k`, `c.user.ref`, `c.parameters.list[0]` | ✅ | bracket string keys preserved verbatim; numeric/computed indices too. Indexing the BARE context (`c[0]`, `c[c.k]`) is rejected |
| `&&` `\|\|` ternary | ✅ | `and` `or`, `(a if c else b)` — Nunjucks `or`/`and` are value-returning like JS, so `x \|\| ""` is simply `(x or "")` |
| `x ?? v` / `njDefault(x, v)` | ✅ | `(x if x != null else v)` — **null-aware**. Nunjucks' `default(v)` filter fires only on *undefined*, so a present `null` would slip through; the inline-if matches JS `??` for null AND missing (Nunjucks `!=` is JS loose inequality) |
| `.toUpperCase .toLowerCase .trim` | ✅ | `\| upper \| lower \| trim` filters (chainable). Property/element access on a filtered result is parenthesized — `c.s.trim().length` → `(s \| trim).length` (unparenthesized, Nunjucks parses a filter named `trim.length`) |
| `=== !== == != < > <= >=` comparison, `+ - * / %` arithmetic | ✅ | **pass-through** — Nunjucks compiles each to the SAME JS operator, so `===` stays *strict* (`"1" === 1` is false), `==` stays *JS-loose* (`"1" == 1` is true), and `+` keeps JS string-concat polymorphism — all engine-verified differentially. A missing operand in arithmetic renders `NaN` on both sides |
| template literals `` `a${x}b` `` | ✅ | → `~` concatenation (`("a" ~ (x) ~ "b")`). Nunjucks `~` stringifies with JS `String()`, so `null`/`undefined` interpolate as `"null"`/`"undefined"` **exactly like a JS template literal** (engine-verified — NOT the `""` that a bare <code v-pre>{{ missing }}</code> renders). A negative numeric literal (`.slice(-2)`) folds through |
| `.split(sep) .replace(a, b) .slice(a, b?)` | ✅ | **verbatim method calls** (`s.split(",")`, composable: `s.split("?")[0]`): Nunjucks evaluates them as the real JS string methods, so first-occurrence `.replace` and negative-index `.slice` agree by construction. Filters were deliberately NOT used — there is no `split` filter, the `slice` filter is Jinja's list-chunking (throws on strings), and `replace(a, b, 1)` diverges from JS on an empty pattern (engine-checked). A method call on a missing value throws at render on both sides |
| array / object literals | ❌ 🔒 | not expressible in <code v-pre>${{ }}</code> |
| `.map/.filter`, function calls, block bodies, multiple params | 🔒 | out of scope — use `jsonata` |

### Nunjucks notes

- A fixture value that is **literally `null`** renders as `""` (like a missing value)
  — the differential harness's `njString` scalarization matches that.
- String literals containing `}}` are safe: the Nunjucks lexer respects quotes while
  scanning for the block terminator (engine-verified).
- A filter applied to a MISSING value can throw at render (`| trim` calls `.replace`
  on it). Guard with `?? ""` first if the value may be absent.

## Closing the gaps — strategy

1. **JSONata 🔧 (high ROI, low risk):** add to `METHOD_MAP`/`GLOBAL_MAP` the methods
   with a direct JSONata function plus a differential case in
   `fnmap.differential.test.ts` (the completeness test enforces this — transpiler
   special-cases are tracked the same way via `SPECIAL_METHOD_FORMS` /
   `SPECIAL_GLOBAL_FORMS`). **Done:** `.slice`→`$substring`,
   `.padStart`/`.padEnd`→`$pad`, `.replaceAll`→`$replace`,
   `.charAt`/`.startsWith`/`.endsWith`→`$substring` forms,
   `parseInt`/`parseFloat`→lenient `$match` shims, object spread→`$merge`,
   block-bodied `.map`/`.filter` lambdas, `.indexOf`→a
   `$contains`/`$substringBefore`/`$length` shim, and `.match(/re/)`→a `$match`
   projection onto the JS `RegExpMatchArray` shape (regex-literal argument only;
   `/g` rejected). **Nothing left open here** — every JS string/array method with a
   value-equivalent JSONata form is now mapped.
2. **Nunjucks 🔧 → done:** Scaffolder <code v-pre>${{ }}</code> verified as stock nunjucks
   grammar (see the note above); comparisons/arithmetic, `~` concat for template
   literals, and `.split`/`.replace`/`.slice` (as verbatim method calls) are in —
   each with a differential test against the real `nunjucks` lib.
3. **🔒 stays out** — control flow in JSONata, logic in Nunjucks. The transpilers
   throw a clear error and point at `raw`.
