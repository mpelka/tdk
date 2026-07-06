# Port a YAML template

You have a hand-written or generated Backstage Scaffolder `Template` YAML and want
it in TDK. Port it by translating section by section. The YAML already gives you the
structure, so this is a mechanical translation, not a redesign. A faithful port
round-trips: compiling it back reproduces the source by value (the layout differs —
see [verify by value](#verify-by-value)).

Work top to bottom.

## The section-by-section map

| YAML | TDK |
| --- | --- |
| `metadata.name` / `title` / `description` / `spec.type` / `spec.owner` / `metadata.tags` | `defineTemplate({ id, title, description, type, owner, tags })` (`metadata.name` → `id`) |
| `spec.parameters` — an array of step objects (each `{ title, properties, required, dependencies }` is one page) | `parameters: [page(title, { … })]` — a value, not a function. A single flat step → flat `parameters: { … }`. Use `parameters: (data) => […]` only with `load()`; its arg is the loaded data, never the `f` ref map (that goes to `steps`/`output`). |
| `page.uiOrder` or a step's `ui:order` | `page(title, props, { uiOrder })` |
| a property `{ type: string, title, description, default, pattern, minLength, maxLength }` | `p.string({ title, description, default, pattern, minLength, maxLength })` |
| a property with `enum: [...]` (labels equal values) | `p.enum(["a", "b"], { title, required })` |
| a property with `enum: [...]` and `enumNames: [...]` (value differs from label) | `p.enum({ enum: [...], enumNames: [...] }, { title })` — lengths must match, or compile throws |
| `type: boolean` / `type: number` / `type: array` | `p.boolean(...)` / `p.number(...)` / `p.array(...)` (for a typed element, `p.array<T>({ items: { … } })`) |
| a property listed in the step's `required: [...]` | `required: true` on that `p.*` field |
| `ui:widget: textarea` (and other `ui:widget`s) | `uiWidget: "textarea"` on the field |
| `ui:field: SomeCustomField` (a custom field extension) | `p.customField({ uiField: "SomeCustomField", uiOptions: { … } })` — emits `ui:field` + `ui:options` verbatim. Wrap a recurring one once with `defineField` in your shared code. |
| `ui:options: { … }` on any field | `uiOptions: { … }` (emitted verbatim as `ui:options`) |
| an `errorMessage` (the ajv-errors keyword) on a property, or `errorMessage: { required: { field: "…" } }` on the object | `errorMessage: "…"` on the field (a string covers every failure, `required` included) or the keyword-object `errorMessage: { pattern, required, … }`. TDK lifts the `required` message to the page/branch for you. |
| a property's `if:` reveal, or a simple `dependencies: { ctrl: { oneOf: [...] } }` gate | `showWhen: controller.is(value)` on the revealed field (hoist the controller to a const; the editor checks the value). The record shorthand `showWhen: { controller: value }` is checked at compile. |
| a `dependencies`/`oneOf` tree `showWhen` cannot shape (one body for several controller values, `not`, chained reveals) | `dep.when(controller, [ dep.eq(v, body), dep.oneOf([...], body), dep.not(v, body) ])` on the page |
| an exotic `dependencies` block with no `dep.*` equivalent (property-level schema deps, cross-field `oneOf`) | `rawDependencies: { … }` on the page — raw JSON-Schema passthrough (emitted verbatim; do not also `dep.when`/`showWhen` the same controller — that collision throws) |
| `spec.steps[]` (`id`, `name`, `action`, `input`, `if`) | `step(id, action, { name, input: { … }, if })` |
| <code v-pre>${{ parameters.x }}</code> in an input | `f.x` (the typed ref) — or `nj((c) => c.parameters.x)` inside a larger expression |
| <code v-pre>${{ steps.s.output.k }}</code> / <code v-pre>${{ user.entity… }}</code> / <code v-pre>${{ secrets.t }}</code> | `nj((c) => c.steps["s"].output.k)` / `nj((c) => c.user…)` / `nj((c) => c.secrets.t)` (note the `.output`) |
| a computed <code v-pre>${{ … }}</code> (fallback, ternary, method call, template literal) | `nj((c) => …)` — author the TS, never hand-write the Nunjucks |
| a `roadiehq:utils:jsonata` step's `data:` map | each value is `nj((c) => …)` — never `jsonata` (see pitfalls) |
| that step's `expression:` string | a typed `jsonata<DataCtx>((c) => …)`, then pass its `.jsonata` accessor as the `expression` input. Object body, or a block body for procedural logic. Read the `data` fields bare (`c.foo` → `foo`, the expression's root IS `data`). |
| a step `if:` condition | `if: nj((c) => …)` (or a literal string or boolean) |
| a value that differs per environment | `env.pick({ test: …, prod: … })` — any env names + optional `default` (never hardcode another env's value — env safety is checked) |
| `spec.output` (`links`, `text`, scalars) | `output: (f) => ({ … })` — annotate the return `Record<string, InputValue>` when it holds lists |
| anything with no typed equivalent | `raw` — a single verbatim or interpolated string only, never logic |

## Six pitfalls

These are the value-level traps a mechanically-correct-looking port gets wrong. Each
is enforced or documented — get them right on the first pass.

### 1. A roadie `data:` value is `nj`, never `jsonata`

Every `data` field is a Scaffolder <code v-pre>${{ … }}</code> template resolved before the
expression runs; the expression's root then is the resolved data map. A
`jsonata(...)` dropped into `data` is inert — it renders as a literal string, never
executed. Only the step's top-level `expression` is `jsonata`. When a `data` field
needs a fallback or light logic, keep it in the `nj` (`nj((c) => c.parameters.name
|| "?")`), or move that logic into the `expression`.

### 2. Never use `jsonata()` as a plain step input

A `jsonata(...)` belongs only as the `expression:` of a `roadiehq:utils:jsonata`
step, passed via its `.jsonata` accessor. Handing a bare `jsonata(...)` to any other
input (a `debug:log` message, an `http` body, a `data` field) throws at compile,
naming the misplaced expression. For a computed value in a normal input, use `nj((c)
=> …)`. JSONata only ever runs inside the roadie action.

### 3. `||` and `&&` are value-preserving

`a || b` yields the first truthy operand's value (not a boolean) in both `nj` and
`jsonata` — so `c.name || "?"` renders the name, and `c.unitPrice || 0` renders the
price. Port a YAML <code v-pre>${{ x or y }}</code>, or an idiomatic JSONata `x ? x : y`, straight to
`c.x || c.y`; do not "fix" it to a boolean. (JSONata's own `or`/`and` return
booleans, which is why you author with `||`.)

### 4. `??` is null-aware; `||` is not

`c.slot ?? "d"` falls back on `null` and absent, but lets a present `""` through
unchanged — three distinct outcomes: value, fallback on null or absent, empty string
passes. `c.slot || "d"` additionally falls back on `""` and `0`. Match whichever the
source YAML used: <code v-pre>${{ x if x != null else d }}</code> → `c.x ?? "d"`;
<code v-pre>${{ x or d }}</code> → `c.x || "d"`.

### 5. `parseInt`/`parseFloat` are lenient shims

They match a numeric prefix (`parseInt("15OFF")` → 15, `parseFloat("3.7px")` → 3.7,
whitespace OK) rather than strict-casting. A value with no numeric prefix (`"none"`,
`"SAVE15x"`) yields missing in JSONata where JS would give `NaN` (JSONata has no
NaN) — so a downstream `?` guard treats it as absent. If you port a YAML expression
that did a raw `$number(...)` (which throws on garbage), the `parseInt` shim is the
faithful, non-throwing equivalent.

### 6. `null` vs absent vs `""` carries into the port

A YAML default that fires only on undefined (Nunjucks `default(v)`) is not `??`; `??`
fires on `null` too. If the source distinguished a submitted-but-empty field (`""`)
from an unsubmitted one, preserve it: `??` keeps `""`, `||` collapses it. When in
doubt, cover present / `null` / absent / `""` in a scenario and read the four
outputs.

## Verify by value

A correct port round-trips, but not byte for byte: `jsonata()` pretty-prints its
`expression` by default (newlines and 2-space indent; an expert's hand-written
JSONata has its own layout), and the YAML key order and expression idiom will differ.
So verify by value, in this loop:

1. Run `tsc --noEmit` first — the load-bearing check, because the typed DSL catches
   wrong refs, bad field names and misspelled inputs. Then run `bun test`.
2. Run `tdk compile template.ts` and read the YAML against the source field by
   field. Each `data` value must be a <code v-pre>${{ … }}</code> template; the `expression`
   must be a JSONata string (`$assert`/`:=`), never a <code v-pre>${{ }}</code>. A value that
   shows up as literal expression source where a <code v-pre>${{ }}</code> belongs is the
   tell-tale of a misplaced expression (pitfalls 1 and 2). `tdk compile` also
   schema-validates by default.
3. Run `tdk execute template.ts` to run your `__fixtures__/scenarios.ts` and check
   each branch's output equals what the source YAML would produce.
4. For an expression-heavy port, prove behavioural equivalence to the source in a
   test rather than eyeballing: `assertExecuteAgainstGold(Tpl, sourceYaml, fixture)`
   (whole run), `assertDifferentialJsonata(myJsonataExpr, sourceExpression,
   fixtures)` (the compiled `jsonata` vs the source's hand-written JSONata, value for
   value and throw for throw), or `assertDifferentialNj(myNjExpr, fixtures)` (render
   both with the real nunjucks engine).

The loud compile errors are on your side. A `jsonata(...)` used outside a roadie
`expression`, a non-`Param` property value, a `showWhen` cycle or a collision with a
`dep.when`/`rawDependencies` on the same controller, an unresolved `env.pick` or
resolver marker leaking into the artifact, an `extraSpec` key colliding with a
modeled `spec` field, and a non-GA `lifecycle` missing `restrictedToUsers` all throw
at compile instead of shipping green.
