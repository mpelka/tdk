# Write expressions

Backstage templates carry logic in two expression languages. TDK gives each a typed
transpiler so you never hand-write either. This page shows when to reach for which
tool and how to write it. For the exhaustive support matrix and every semantic
divergence, see the [expression support reference](/reference/expression-support).

## Which tool to reach for

Start here. Most values need no expression at all.

| You want | Use | Example |
| --- | --- | --- |
| a plain parameter value | `f.<name>` | `input: { cakeName: f.cakeName }` |
| a fixed string with params spliced in | `raw` | `` raw`Baking ${f.cakeName}` `` |
| a computed <code v-pre>${{ … }}</code> value — a fallback, a comparison, a method call | `nj()` | `nj((c) => c.parameters.notes || "none")` |
| the `expression` of a `roadiehq:utils:jsonata` step | `jsonata()` | one arrow, object or block body |

The rule of thumb: reach for `nj()` for anything that lands in a <code v-pre>${{ … }}</code>
interpolation, and for `jsonata()` only inside a roadie step's `expression`. Never
hand-write Nunjucks or JSONata — author the TypeScript and let the transpiler emit
it, so the differential harness can check it.

## Interpolation vs an expression field

Not every value that needs an expression lives inside a <code v-pre>${{ … }}</code>
interpolation. This distinction decides `nj()` vs `jsonata()`:

- A step `input` field, an `if` condition and `output` values are Nunjucks-templated
  strings. Write these with `nj()` (or `raw`); they compile to <code v-pre>${{ … }}</code>.
- A `roadiehq:utils:jsonata` step's `expression` key (and only that key) is JSONata
  directly, not a <code v-pre>${{ … }}</code> wrapper. Write it with `jsonata()`. Its `data`
  map is still built with `nj()`, because `data` values are ordinary `input`-style
  Nunjucks templates resolved before the expression runs.

```ts
step("build-ticket", "roadiehq:utils:jsonata", {
  input: {
    data: {
      customerName: nj((c) => c.parameters.customerName), // Nunjucks — a `${{ }}` input field
    },
    expression: ticketPayload.jsonata,                    // JSONata — the raw expression, no ${{ }}
  },
});
```

A `jsonata(...)` dropped anywhere other than a roadie `expression` throws at compile.
A `jsonata(...)` dropped into a `data` field ships as an inert literal string. See
the [porting pitfalls](/guide/porting#six-pitfalls) for both traps.

## `jsonata()`

Transpiles a typed arrow's body to a JSONata string at build time, and returns a
value usable anywhere `raw` is (a step `input`, an `output`, or a step `if`). At
compile it renders to <code v-pre>${{ &lt;jsonata&gt; }}</code> for the Scaffolder to evaluate at
run time.

`Ctx` is the JSONata root context type. The arrow's single parameter maps to that
root, so `c.parameters.cakeName` compiles to `parameters.cakeName` (the context
param is stripped).

```ts
import { jsonata } from "@tdk/core";

type TicketCtx = {
  parameters: { cakeName: string; owner: { members: { email: string }[] }; tags: string[] };
};

const orderTicket = jsonata<TicketCtx>((c) => ({
  summary: `New cake: ${c.parameters.cakeName}`,
  station: { key: "OVENS" },
  description: c.parameters.owner.members.length > 0
    ? `Owned by ${c.parameters.owner.members.map((m) => m.email).join(", ")}`
    : "Unassigned",
  labels: c.parameters.tags,
}));
```

How it works: the arrow's source is parsed with the TypeScript compiler API, and a
whitelisted subset of the AST is walked, emitting JSONata with explicit
parenthesization to preserve precedence. Every result is validated by parsing it
with the `jsonata` engine — if the transpiler ever produced something unparseable
it throws rather than emit garbage.

Expressions may reference only the context parameter, their own lambda parameters
(in `.map`/`.filter`) and literals — no closures or external variables. An
unsupported reference or node throws a clear, located error naming the construct and
pointing at the `raw.jsonata` escape hatch.

### Block-bodied arrows

Real Backstage JSONata is procedural: guards, variable bindings, sequencing,
conditional array-building, then a returned object. `jsonata(...)` accepts a
block-bodied arrow and emits a JSONata block `( … ; … ; <final> )`:

| TS / JS statement | JSONata | Notes |
| --- | --- | --- |
| `const x = <e>;` / `let x = <e>;` | `$x := <e>` | binding |
| `x = <e>;` | `$x := <e>` | reassignment (JSONata rebinds) |
| `assert(cond, msg);` | `$assert(cond, msg)` | bare guard statement |
| `return <e>;` | `<e>` | must be the final statement |
| reference to a bound `x` | `$x` | bound names become JSONata variables |

```ts
import { jsonata, assert } from "@tdk/core";

const pricing = jsonata<{ customerName: string; rushOrder: string }>((c) => {
  assert(c.customerName !== "", "A customer name is required.");
  let lineItems = [{ label: "Base", amount: 20 }];
  lineItems = lineItems.concat([{ label: "Delivery", amount: 4 }]);
  return { lineItems: lineItems };
});
```

`assert` is the author-facing mirror of `$assert`: it throws `Error(msg)` when
`cond` is false, so a failing guard runs on both sides of a differential.

### The JSONata escape hatch

```ts
// Inline verbatim JSONata for anything unsupported. Still parse-validated.
jsonata.raw`$sum(parameters.amounts)`   // equivalently: raw.jsonata`$sum(parameters.amounts)`
```

`raw.jsonata` has no JS oracle, so it cannot be used with `differential()`.

## `nj()`

The Nunjucks analog of `jsonata`: transpiles a typed arrow to a Nunjucks expression
and renders to <code v-pre>${{ … }}</code> at compile, usable anywhere `raw`/`jsonata` are. As
with `jsonata`, the context param is the Nunjucks root, so `c.parameters.x` compiles
to `parameters.x`.

```ts
import { nj } from "@tdk/core";

nj((c) => c.user);                              // => ${{ user }}
nj((c) => c.parameters.notes || "none");        // => ${{ (parameters.notes or "none") }}
nj((c) => c.user.entity.metadata.name
        || c.steps["fetch-baker"].output.result.toUpperCase());
//  => ${{ (user.entity.metadata.name or steps["fetch-baker"].output.result | upper) }}
```

`nj` targets the restricted Nunjucks expression inside a Scaffolder <code v-pre>${{ … }}</code>
— value access, defaults, comparisons and arithmetic, and simple casing. It is
intentionally not for control flow: `if`/`for`/block bodies, array/object literals
and arbitrary function calls all throw a located `NjTranspileError` pointing at the
<code v-pre>raw`${{ … }}`</code> escape hatch. The compiled output is parse-validated with the
real `nunjucks` engine at build time.

## `??` vs `||` — pick the right fallback

Two fallback operators, three outcomes. Getting these right is the most common
expression mistake:

- `c.slot ?? "d"` is null-aware. It falls back on `null` and on absent, but lets a
  present `""` through unchanged. Three distinct outcomes: value / fallback / empty
  string passes.
- `c.slot || "d"` is value-preserving but also falls back on `""` and `0`.

Match whichever the source used. Both `??` and `||` return the operand's value, not
a boolean — so `c.name || "?"` renders the name and `c.unitPrice || 0` renders the
price. Do not "fix" a `||` to a boolean.

## Pretty vs compact — `.jsonata` and `.compact`

Compiled JSONata expressions are pretty-printed by default: long blocks put each
`$x := …;` statement on its own line, long ternaries put each branch on its own
line, and long object or array constructors split member-per-line — all 2-space
indented. Short expressions stay single-line. JSONata is whitespace-insensitive and
the emitted YAML renders multi-line strings as block scalars, so this stays valid
and diffs cleanly.

- `JsonataExpr.jsonata` is the pretty emission — what ships by default, what gets
  parse-validated, and what the differential harness evaluates.
- `JsonataExpr.compact` is the canonical single-line form.
- The layout choice is the accessor. Both strings are baked at build time, so a
  roadie step's `expression:` field carries whichever form you hand it — `.jsonata`
  for reviewable multi-line YAML, `.compact` when single-line output is wanted.
- `raw.jsonata` strings are never reformatted, and `nj()` emissions are always
  single-line — they live inside <code v-pre>${{ … }}</code> interpolations where multi-line
  adds risk without benefit.

## Check your expression against a TS oracle

`differential(exprFn, fixtures)` runs each fixture through both the JS oracle
(`exprFn.fn`) and the compiled JSONata (`jsonata(exprFn.jsonata).evaluate`), and
deep-equals them. `assertDifferential(...)` is the same but throws a detailed diff
on any mismatch. The harness is throw-aware: two evaluations agree when they produce
equal values or both throw the same message — so `assert`/`$assert` guards are
first-class fixtures. `differentialJsonata(exprFn, originalJsonata, fixtures)`
compares the compiled JSONata against an arbitrary reference JSONata string.

```ts
import { test } from "bun:test";
import { assertDifferential } from "@tdk/core";

test("order ticket: TS oracle === compiled JSONata", async () => {
  await assertDifferential(orderTicket, [
    { parameters: { cakeName: "a", owner: { members: [] }, tags: ["oven"] } },
    { parameters: { cakeName: "b", owner: { members: [{ email: "x@y" }] }, tags: [] } },
  ]);
});
```

`differentialNj(njFn, fixtures)` and `assertDifferentialNj(...)` are the Nunjucks
equivalents. They render the compiled Nunjucks with the real `nunjucks` engine
(autoescape off, as Backstage runs it) and compare it to the TS oracle, scalarized
the way Nunjucks prints it (`null`/`undefined` → `""`, booleans and numbers via
`String`, arrays comma-joined).

## Semantic divergences

Both transpilers are engine-verified against a large share of real TS/JS semantics,
but a handful of cases evaluate differently between the JS oracle and the real
engine — `$boolean` truthiness of `[]`/`{}`, missing-parent access agreeing only
through `?.`, `Number("")`, `Math.round` half-to-even vs half-up, and a few more.
The differential harness surfaces every one; TDK's own fixtures stay inside the
agreeing domain.

The full, authoritative list of supported constructs and every semantic divergence
— kept in lock-step with the engine-verified differential suite — is the
[expression support reference](/reference/expression-support). The source of truth
is the code: the curated `METHOD_MAP`/`GLOBAL_MAP` in `packages/core/src/expr/` and
the differential tests.
