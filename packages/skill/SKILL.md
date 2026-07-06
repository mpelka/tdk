---
name: tdk
description: Author and test Backstage Scaffolder templates in TypeScript with TDK (@tdk/core) — typed params, steps, env-aware values, compile-time data, and scenario tests — compiling to schema-valid template YAML.
---

# TDK — authoring Backstage templates in TypeScript

TDK (`@tdk/core`) is a TypeScript DSL that **compiles** to a Backstage Scaffolder
`Template` entity (the `template.yaml`). You write a typed `defineTemplate(...)`
value; `compile` turns it into YAML, once per deploy target. You never hand-write
JSON Schema, JSONata, Nunjucks, or YAML.

Use this skill to author a new template, extend one, or write its tests.

## Mental model

A template has three parts, and a template is a plain **value** (no class, no `new`):

```ts
import { defineTemplate, p, page, step } from "@tdk/core";

export const OrderCake = defineTemplate({
  id: "order-cake",            // metadata.name (unique in the catalog)
  title: "Order a Cake",
  description: "Order a cake from a partner bakery.",
  type: "service",             // spec.type
  tags: ["bakery"],

  // 1) parameters — the FORM (pages + fields)
  parameters: {
    flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
    notes: p.string({ title: "Notes", uiWidget: "textarea" }),
  },

  // 2) steps — the ACTIONS. `f` is an inferred, typed map of every param's ref.
  steps: (f) => [
    step("place", "bakery:place", { name: "Place order", input: { flavor: f.flavor, notes: f.notes } }),
  ],

  // 3) output — optional spec.output (same inferred `f`)
  output: (f) => ({ flavour: f.flavor }),
});
```

- `f.flavor` is the param's **ref** — it renders to `${{ parameters.flavor }}` and is
  typed (`Ref<"Vanilla" | "Chocolate">`). Use `f.<name>` anywhere a step/output value
  goes. Param names must be **unique across all pages** (the form is one flat namespace).
- `steps`/`output` are functions of `f`; `parameters` is a value (or a function of
  loaded data — see **load()**).

## Parameters

`parameters` takes **either** a flat props object (one page, above) **or** an array
of `page(title, props)` for a multi-page form:

```ts
parameters: [
  page("Cake", {
    flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
    size: p.enum(["Small", "Large"], { title: "Size", required: true }),
  }),
  page("Extras", { notes: p.string({ title: "Notes", uiWidget: "textarea" }) }),
],
```

`page(title, props, { uiOrder })` — `uiOrder` sets field order on that page.

### Field types (`p.*`)

| Builder | Use |
|---|---|
| `p.string({...})` | text; opts: `pattern`, `minLength`, `maxLength`, `default`, `uiWidget`, `uiOptions` |
| `p.enum([...])` or `p.enum({ enum, enumNames }, ...)` | dropdown; array shorthand, or object form when value≠label |
| `p.boolean({...})` | checkbox |
| `p.number({...})` | numeric |
| `p.array({...})` | list of values |
| `p.customField({ type?, uiField, uiOptions })` | any Backstage custom field extension — `ui:field` + `ui:options` emitted verbatim (e.g. a `CakePickerWithDefault` picker). For a reusable typed helper, wrap it once with `defineField` in your shared code. |

Common options on every field: `title`, `description`, `required: true`,
`default`, `uiWidget` (→ `ui:widget`), `uiOptions` (→ `ui:options`).

```ts
p.string({ title: "Bakery code", pattern: "^[A-Z]{2,10}$", required: true })
p.enum({ enum: ["S", "M", "L"], enumNames: ["Small", "Medium", "Large"], title: "Size" })
```

### Conditional fields

Show a field only when another field has a given value — declaratively with
`showWhen`. Hoist the controller to a const and name it with `.is(value)`, so the
editor literal-checks the value (`style.is("Layred")` is a type error):

```ts
const style = p.enum(["Plain", "Layered"], { title: "Style", required: true });
parameters: [
  page("Cake", {
    style,
    // only shown when style === "Layered"
    topper: p.string({ title: "Topper", showWhen: style.is("Layered") }),
  }),
],
```

`.is(value)` is one branch; `.in(a, b)` is OR; `all(c1, c2)` (from `@tdk/core`) ANDs.
The inline record shorthand `showWhen: { controller: value }` needs no hoisting and is
checked at compile. For branch shapes `showWhen` can't express (e.g. one body for
several controller values), drop to the power-tool
`dep.when(controller, [ dep.eq(v, body), dep.oneOf([...], body), dep.not(v, body) ])`.

### Reusable pages (fragments)

`fragment(title, props)` (from `@tdk/core`) builds a reusable colocated **page** —
authored once, dropped into many templates. A fragment is just a `page` value, so
compose it into `parameters` like any page:

```ts
import { fragment, p } from "@tdk/core";

const teamPage = fragment("Team", { team: p.string({ title: "Team", required: true }) });
```

**Concrete org fragments live in YOUR shared template code, not in `@tdk/core`**
(core stays org-agnostic — it ships only the `fragment()` mechanism). The common one
is a **Baking Justification** page, built with `fragment()` and kept in a shared
module you import from:

```ts
import { bakingJustificationPage } from "../_shared/fragments";  // YOUR shared fragment

parameters: [
  page("Cake", { /* … */ }),
  bakingJustificationPage(),   // a single-field page; MUST be the LAST page
],
```

That fragment contributes a field named **`baking_justification`** — reference it
in `steps`/`output` as `f.baking_justification` (snake_case, **not**
`f.bakingJustification`). Compose it **last** (see Rules).

## Steps

```ts
step(id, action, { name?, input?, if? })
```

`input` values may be: literals, `f.<param>` refs, `env.pick(...)`, or expressions
(`raw` / `jsonata` / `nj`). `if` is a templated run condition.

```ts
steps: (f) => [
  step("place", "bakery:place", {
    name: "Place order",
    input: { flavor: f.flavor },
    if: nj((c) => c.secrets.token),   // run only if a token is present
  }),
],
```

## Per-environment values — `env.pick`

A template compiles once per target env. Env names are open strings — `test` /
`prod`, or `dev` / `staging` / `prod`, or a single env. `env.pick` resolves to
the matching value (or a reserved `default` fallback), giving **environment-safety
by construction**; compiling for an env a pick doesn't know (with no `default`)
throws, naming the known envs and the miss:

```ts
import { env } from "@tdk/core";
input: {
  cluster: env.pick({ test: "test-cluster", prod: "prod-cluster" }),      // two envs
  region:  env.pick({ prod: "eu-west", default: "eu-central" }),          // default fallback
}
```

## Expressions (when each)

- **`raw`** — a verbatim Scaffolder string, interpolating the typed **`f.<name>`
  refs** (never `c.parameters.<name>` — that context exists only inside `nj` /
  `jsonata`):
  ``raw`https://bakery.example/orders/${f.bakeryCode}/${f.cakeName}` ``
  `raw` is for a **single static/interpolated string with no logic** — *never*
  multi-statement JSONata/Nunjucks. For any guards, intermediate values, or
  conditional assembly, use a `jsonata` **block body** (see below) — hand-writing
  that dialect in `raw` is the #1 source of broken templates.
- **`nj((c) => …)`** — TypeScript → Nunjucks `${{ … }}`. Use for templating that
  reads the run context `c` (see below).
- **`jsonata((c) => …)`** — TypeScript → JSONata, for `roadiehq:utils:jsonata`
  steps and richer transforms (block bodies, `$assert`, array ops). For prefix/suffix
  stripping use the helpers `substringAfter(s, sep)` / `substringBefore(s, sep)`
  (import from `@tdk/core`) — e.g. `substringAfter(c.ref, "user:default/")` — rather
  than `.split(...)`.

Author in TS; **never hand-write a JSONata/Nunjucks string** — always use
`nj`/`jsonata` (the transpiler gets the references + root right; a hand-written
string usually has the wrong root and won't be checked). Both have differential
test harnesses behind them.

### The run context `c` (inside `nj` / `jsonata`)

- `c.parameters.<name>` — a submitted form value.
- `c.steps["<step-id>"].output.<key>` — a previous step's output. **Note the
  `.output`**: e.g. `c.steps["fetch-user"].output.result`, *not* `.result`.
- `c.secrets.<name>`, and `c.user` (e.g. `c.user.entity.metadata.name`, `c.user.ref`).

### `roadiehq:utils:jsonata` steps (`data` + `expression`)

This action evaluates a JSONata `expression` whose **root is the step's `data`
input**. So inside the `jsonata`, read the data fields **bare** — `c.foo` compiles
to `foo`, **not** `data.foo`. Build `data` with `nj`, then the `expression` with a
typed `jsonata` whose context type *is* the data map:

```ts
type PayloadCtx = { flavor: string; size: string };
const payload = jsonata<PayloadCtx>((c) => ({
  summary: `CAKE - ${c.flavor} - ${c.size}`,   // compiles to: "CAKE - " & flavor & " - " & size
}));

step("compute", "roadiehq:utils:jsonata", {
  input: {
    data: {
      flavor: nj((c) => c.parameters.flavor),
      size: nj((c) => c.parameters.size),
    },
    expression: payload.jsonata,   // ← the compiled JSONata string
  },
});
```

**`data` values are `nj`, NEVER `jsonata`.** Every `data` field is a Scaffolder
template (`${{ … }}`) resolved *before* the expression runs — so a `jsonata(...)`
dropped into `data` compiles to an inert **literal string** (the JSONata is never
executed) and ships green, the same silent-failure class as the `let` trap below.
When a `data` field needs a fallback or light logic, keep it in the `nj`
(`nj((c) => c.user.entity.metadata.name || c.steps["fetch"].output.result.toUpperCase())`
→ `${{ name or result | upper }}`), or move that logic into the top-level
`expression`, which *is* JSONata. Only the step's `expression` is ever `jsonata`.

**Procedural expressions — use a block body** (`(c) => { … return … }`), *never*
`raw`. Guards, intermediate values, and conditional assembly all belong inside the
`jsonata` block; the transpiler emits the correct JSONata dialect for you —
`assert(cond, msg)` → `$assert(…)`, `const x = …` → `$x := …`, ternaries, template
literals → `&`, array `.concat`/spread. **The trap:** JSONata binds variables with
`$x :=` and has **no `let`** — so a hand-written `` raw`( let x := … )` `` is a
silent parse error that ships green (tsc/`bun test` don't run the JSONata). Writing
it as a typed block body makes that impossible:

```ts
type OrderCtx = { ovenLine: string; headBaker: string; headBakersManager: string; priority: string; filling?: string };
const payload = jsonata<OrderCtx>((c) => {
  assert(c.headBaker !== "", "The head baker could not be resolved.");        // → $assert(…)
  const crewAssignment =                                                      // → $crewAssignment := …
    c.ovenLine === "Ovens"   ? "Oven Crew"
    : c.ovenLine === "Pastry" ? "Pastry Crew"
    : "";
  const fillingLine = c.filling ? `Filling: ${c.filling}\n` : "";            // conditional line
  const stages =
    c.priority === "High"
      ? [{ identifier: "Head Baker", approvers: [c.headBaker] },
         { identifier: "Head Baker's Manager", approvers: [c.headBakersManager] }]
      : [{ identifier: "Head Baker", approvers: [c.headBaker] }];
  return { crewAssignment, orderNotes: fillingLine, approvalChain: stages };
});
```

The step's **output is `{ result: <the expression's value> }`** — so a later step or
the template `output` reads it as `c.steps["compute"].output.result`, and
`c.steps["compute"].output.result.summary` when the expression returned an object.

### Output with lists

When `output` returns arrays or heterogeneous objects (e.g. a `text: [...]` list
where only some items carry a `default`), **annotate the function's return type** so
TS checks element-wise instead of inferring a too-narrow union — and **do NOT
flatten the lists into scalar keys** to dodge a type error:

```ts
import type { InputValue } from "@tdk/core";

output: (f): Record<string, InputValue> => ({
  text: [
    { title: "Summary", content: nj((c) => c.steps["compute"].output.result.summary) },
    { title: "Status", content: nj((c) => c.steps["register"].output.body), default: true },
  ],
  links: [{ title: "My Orders", url: nj((c) => c.steps["register"].output.link) }],
}),
```

## Compile-time data — `load()`

Fetch external data **at compile time** (TDK's `generateStaticParams`) and bake it
into the form as real options. `load({ env })` is env-aware, so each target can bake
different options. Its result feeds `parameters(data)` — **only** `parameters`;
`steps`/`output` are unchanged.

```ts
import { defineTemplate, type LoadContext, p, page, step } from "@tdk/core";
import { bakery } from "./clients";   // a plugin client; real or synthetic

export const load = async ({ env }: LoadContext) => ({
  flavors: await bakery.flavors(env),
});

export const OrderCake = defineTemplate({
  id: "order-cake", title: "Order a Cake", type: "service",
  load,                                   // passing it in types `data`
  parameters: (data) => [                 // data: { flavors: string[] }
    page("Cake", { flavor: p.enum(data.flavors, { title: "Flavour", required: true }) }),
  ],
  steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
});
```

A `load()` template must compile via the async path (`compileResolved` / `compileAll`
/ `execute`); the synchronous `compile()` throws. **Mocking** is two-tier: a scenario
fixture's `loaded: {…}` injects data (skips `load()`, deterministic); or MSW fakes the
network while real `load()` runs.

## Testing

Simulate a run with `execute(template, fixture)` — it renders interpolations and runs
the pure (jsonata) steps; external steps are mocked in the fixture. An explicit fixture
mock always wins over a registered action simulator (specific beats general) — the
simulator only runs for steps the fixture leaves unmocked.

```ts
import { execute } from "@tdk/core";

const run = await execute(OrderCake, {
  parameters: { flavor: "Chocolate", notes: "extra sprinkles" },
  steps: { place: { output: { ok: true } } },   // mock the external step
  // loaded: { flavors: [...] },                 // only for load() templates
});
// execute's results are typed `unknown` (the run context is dynamic). Assert on
// the WHOLE value with toEqual, or CAST before any property access — never
// `run.output.text` directly (that's a TS18046 'unknown' error):
expect(run.steps.place.input).toEqual({ flavor: "Chocolate", notes: "extra sprinkles" });
const out = run.output as { text: { title: string; content: string }[] };
// Pick the env with the 3rd arg — shape is `{ target }`, NOT `{ env }`:
//   await execute(OrderCake, fixture, { target: { env: "prod", outDir: "" } });
```

Put scenarios in `__fixtures__/scenarios.ts` and snapshot them with `tdk test`:

```ts
import type { ExecuteFixture } from "@tdk/core";
export interface CakeParams { flavor: string; notes?: string }
export const scenarios: { name: string; branches: string[]; fixture: ExecuteFixture<CakeParams> }[] = [
  { name: "chocolate", branches: [], fixture: { parameters: { flavor: "Chocolate" }, steps: { place: { output: {} } } } },
];
```

- `tdk test` runs every scenario and snapshots its output (`__snapshots__/scenarios.snap`);
  `tdk test -u` accepts changes, `--ci` fails on missing.
- **Halt at the first failed step.** A step that ends with an `error` — a jsonata
  `$assert`/expression that throws, or an input that fails to render — halts the run,
  like real Backstage: later steps are `{ notReached: true }` (never rendered, no
  output) and the template `output` is `undefined`. A falsy `if:` `skipped` step does
  NOT halt — steps after it still run.
- `validate(object)` schema-checks a compiled entity against the real Backstage schema.
- `compile(tpl, target)` (sync) — `target` is a **positional** `{ env, outDir }`
  (e.g. `compile(OrderCake, { env: "test", outDir: "" })`), returns `{ yaml, object }`.
  For `load()`/marker templates use `compileResolved(tpl, target)` (async) — sync
  `compile` **throws** on them.
- **`tsc --noEmit` is the most valuable check — always run it.** TDK's types catch
  wrong field names (e.g. `f.baking_justification`, not `f.bakingJustification`),
  missing/misspelled inputs, and bad refs. **`bun test` does NOT typecheck** (Bun
  erases types and runs), so a type error silently becomes `undefined`. If you
  verify your work in a loop, typecheck *first*, then `bun test`.

A `template.test.ts` (bun:test) typically asserts: compiles to a valid entity,
env-specific behaviour (`env.pick`), and a couple of `execute` outcomes.

### Read what you compiled

`tsc` and `bun test` prove your template is *internally consistent* — they never run
the compiled JSONata/Nunjucks, so a semantically-wrong expression passes both. Before
you finish, look at what you actually produced:

- **`tdk compile template.ts`** prints the compiled YAML. Read each step: `data` values
  must be `${{ … }}` (from `nj`); the top-level `expression` is a JSONata string. A
  value that shows up as literal source text (`$…`, `:=`) where a `${{ }}` belongs is
  the tell-tale of a misplaced expression (see the `data`-vs-`expression` rule above).
- **`tdk execute template.ts --json`** runs your `__fixtures__/scenarios.ts` and prints
  each scenario's output — check every branch against the ticket.

Fix anything that looks off and re-check. This catches *mechanical* mistakes (a literal
where an evaluated value belongs); it is **not** a correctness guarantee — you are still
your own oracle for whether the logic matches intent, so read the output carefully.

## Rules (must follow)

1. **Baking Justification — only when the requirements ask for one.** When a
   template has a baking justification, it must be a single field on the **LAST
   page**: compose `bakingJustificationPage()` last, never with a sibling field.
   Do **not** add it to templates that don't call for it.
2. **Param names are unique across all pages** (one flat `parameters.X` namespace).
3. **Per-env values use `env.pick`**, never hardcode another env's value — env-safety is checked.
4. **Restrict a non-GA template** via `lifecycle: { state: "uat", restrictedToUsers: [...] }`.
5. **Never hand-write a JSONata/Nunjucks/YAML string.** Author expressions with
   `jsonata(...)` / `nj(...)`. `raw` is ONLY a single verbatim string with no logic
   (a URL, a literal ref) — **never** put `let` / `$assert` / a ternary / multiple
   statements inside `raw`. Any guard, intermediate variable, or conditional →
   a `jsonata` **block body** `(c) => { … return … }`; the transpiler emits valid
   JSONata, hand-written `raw` does not (JSONata has **no `let`** — binding is
   `$x :=` — so `` raw`( let x := … )` `` is a silent parse error that ships green).

## Worked example (multi-page + load + fragment + test)

```ts
// template.ts
import { defineTemplate, type LoadContext, env, p, page, step } from "@tdk/core";
import { bakingJustificationPage } from "../_shared/fragments";   // your shared org fragment
import { bakery } from "./clients";

export const load = async ({ env }: LoadContext) => ({ flavors: await bakery.flavors(env) });

export const OrderCake = defineTemplate({
  id: "order-cake", title: "Order a Cake", type: "service", tags: ["bakery"],
  load,
  parameters: (data) => [
    page("Cake", {
      flavor: p.enum(data.flavors, { title: "Flavour", required: true }),
      tier: p.enum(["Single", "Layered"], { title: "Tier", required: true }),
      topper: p.string({ title: "Topper", showWhen: { tier: "Layered" } }),
    }),
    bakingJustificationPage({ description: "Why do you need this cake?" }),
  ],
  steps: (f) => [
    step("place", "bakery:place", {
      name: "Place order",
      input: { flavor: f.flavor, tier: f.tier, kitchen: env.pick({ test: "test-kitchen", prod: "prod-kitchen" }) },
    }),
  ],
  output: (f) => ({ flavour: f.flavor }),
});
```

```ts
// template.test.ts
import { describe, expect, test } from "bun:test";
import { compileResolved, validate } from "@tdk/core";
import { OrderCake } from "./template";

const nonprod = { env: "test", outDir: "" } as const;

describe("order-cake", () => {
  test("compiles to a valid entity with baked flavours", async () => {
    const { object } = await compileResolved(OrderCake, nonprod);
    expect(object.metadata.name).toBe("order-cake");
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});
```

## Porting an existing YAML template

Given a hand-written (or generated) Backstage Scaffolder `Template` YAML, port it to
TDK by translating it **section-by-section**. The YAML already hands you the
structure, so this is a **mechanical translation, not a redesign** — a faithful port
**round-trips**: compiling it back reproduces the source (by *value* — the layout
differs, see the verification loop). Work top to bottom.

### The section-by-section map

| YAML | TDK |
|---|---|
| `metadata.name` / `title` / `description` / `spec.type` / `spec.owner` / `metadata.tags` | `defineTemplate({ id, title, description, type, owner, tags })` (`metadata.name` → `id`) |
| `spec.parameters` — an **array of step objects** (each `{ title, properties, required, dependencies }` = one page) | `parameters: [page(title, { … })]` — a **value**, not a function. A single flat step (one properties block, no per-page split) → flat `parameters: { … }`. Use `parameters: (data) => […]` **only** with `load()`; its arg is the loaded data, never the `f` ref map (that goes to `steps`/`output`). |
| `page.uiOrder` / a step's `ui:order` | `page(title, props, { uiOrder })` |
| a property `{ type: string, title, description, default, pattern, minLength, maxLength }` | `p.string({ title, description, default, pattern, minLength, maxLength })` |
| a property with `enum: [...]` (labels == values) | `p.enum(["a", "b"], { title, required })` |
| a property with `enum: [...]` **and** `enumNames: [...]` (value ≠ label) | `p.enum({ enum: [...], enumNames: [...] }, { title })` — lengths must match (a mismatch throws at compile) |
| `type: boolean` / `type: number` / `type: array` | `p.boolean(...)` / `p.number(...)` / `p.array(...)` (for a typed element, `p.array<T>({ items: { … } })`) |
| a property listed in the step's `required: [...]` | `required: true` on that `p.*` field |
| `ui:widget: textarea` (and other `ui:widget`s) | `uiWidget: "textarea"` on the field |
| `ui:field: SomeCustomField` (a custom field extension) | `p.customField({ uiField: "SomeCustomField", uiOptions: { … } })` — emits `ui:field` + `ui:options` verbatim. Wrap a recurring one once with `defineField` in your shared code and import that. |
| `ui:options: { … }` on any field | `uiOptions: { … }` (emitted verbatim as `ui:options`) |
| a property's `if:` reveal, or a simple `dependencies: { ctrl: { oneOf: [...] } }` gate | `showWhen: controller.is(value)` on the revealed field (hoist the controller to a const; the editor checks the value). The record shorthand `showWhen: { controller: value }` is checked at compile. |
| a `dependencies`/`oneOf` tree that `showWhen` can't shape (one body for several controller values, `not`, chained reveals) | `dep.when(controller, [ dep.eq(v, body), dep.oneOf([...], body), dep.not(v, body) ])` on the page |
| an **exotic** `dependencies` block with no `dep.*` equivalent (property-level schema deps, cross-field `oneOf`) | `rawDependencies: { … }` on the page — the raw JSON-Schema passthrough (emitted verbatim; do not also `dep.when`/`showWhen` the same controller — that collision throws) |
| `spec.steps[]` (`id`, `name`, `action`, `input`, `if`) | `step(id, action, { name, input: { … }, if })` |
| `${{ parameters.x }}` in an input | `f.x` (the typed ref) — or `nj((c) => c.parameters.x)` inside a larger expression |
| `${{ steps.s.output.k }}` / `${{ user.entity… }}` / `${{ secrets.t }}` | `nj((c) => c.steps["s"].output.k)` / `nj((c) => c.user…)` / `nj((c) => c.secrets.t)` (note the `.output`) |
| a computed `${{ … }}` (fallback, ternary, method call, template-literal) | `nj((c) => …)` — author the TS, never hand-write the Nunjucks |
| a `roadiehq:utils:jsonata` step's `data:` map | each value is `nj((c) => …)` — **NEVER `jsonata`** (see pitfalls) |
| that step's `expression:` string | a typed `jsonata<DataCtx>((c) => …)`, then pass its **`.jsonata`** accessor as the `expression` input. Object body, or a **block body** for procedural logic (`$assert` guards, intermediate `:=` vars). Read the `data` fields **bare** (`c.foo` → `foo`, the expression's root IS `data`). |
| a step `if:` condition | `if: nj((c) => …)` (or a literal string / boolean) |
| a value that differs per environment | `env.pick({ test: …, prod: … })` — any env names + optional `default` (never hardcode another env's value — env-safety is checked) |
| `spec.output` (`links`, `text`, scalars) | `output: (f) => ({ … })` — annotate the return `Record<string, InputValue>` when it holds lists |
| anything with no typed equivalent | `raw` — a single verbatim/interpolated string only, **never** logic |

### Pitfalls the repo learned the hard way

These are the value-level traps that a mechanically-correct-looking port gets wrong.
Each is enforced or documented — get them right on the first pass:

1. **A `roadiehq:utils:jsonata` `data:` value is `nj`, NEVER `jsonata`.** Every
   `data` field is a Scaffolder `${{ … }}` template resolved *before* the expression
   runs; the expression's root then *is* the resolved data map. A `jsonata(...)`
   dropped into `data` is inert — it renders as a literal string, never executed.
   Only the step's top-level `expression` is `jsonata`. When a `data` field needs a
   fallback or light logic, keep it in the `nj` (`nj((c) => c.parameters.name || "?")`),
   or move that logic into the `expression`.
2. **Never use `jsonata()` as a plain step-input value.** A `jsonata(...)` belongs
   *only* as the `expression:` of a `roadiehq:utils:jsonata` step, passed via its
   **`.jsonata`** accessor. Handing a bare `jsonata(...)` to any other input (a
   `debug:log` `message`, an `http` `body`, a `data` field) is an error — it
   **throws at compile** naming the misplaced expression. For a computed value in a
   normal input, use `nj((c) => …)` instead; JSONata only ever runs inside the roadie
   action.
3. **`||` / `&&` are value-preserving.** `a || b` yields the first *truthy operand's
   value* (not a boolean) in both `nj` and `jsonata` — so `c.name || "?"` renders the
   name, and `c.unitPrice || 0` renders the price. Port a YAML `${{ x or y }}` / an
   idiomatic JSONata `x ? x : y` straight to `c.x || c.y`; do not "fix" it to a
   boolean. (JSONata's own `or`/`and` return booleans — which is why you author with
   `||`, not by hand.)
4. **`??` is null-aware; `||` is not — and `""` is a third outcome.** `c.slot ?? "d"`
   falls back on `null` **and** absent, but lets a present `""` through unchanged
   (three distinct outcomes: value / fallback-on-null-or-absent / empty-string-passes).
   `c.slot || "d"` additionally falls back on `""` and `0`. Match whichever the source
   YAML used: `${{ x if x != null else d }}` → `c.x ?? "d"`; `${{ x or d }}` → `c.x || "d"`.
5. **`parseInt` / `parseFloat` are lenient shims, and no-prefix → *missing*, not NaN.**
   They match a numeric prefix (`parseInt("15OFF")` → 15, `parseFloat("3.7px")` → 3.7,
   whitespace OK) rather than strict-casting. A value with **no** numeric prefix
   (`"none"`, `"SAVE15x"`) yields **missing** in JSONata where JS would give `NaN`
   (JSONata has no NaN) — so a downstream `?` guard treats it as absent. If you port a
   YAML expression that did a raw `$number(...)` (which throws on garbage), the
   `parseInt` shim is the faithful, non-throwing equivalent.
6. **`null` vs absent vs `""` — the `??` distinctions carry into the port.** A YAML
   default that fires only on *undefined* (Nunjucks `default(v)`) is **not** `??`;
   `??` fires on `null` too. If the source distinguished a submitted-but-empty field
   (`""`) from an unsubmitted one, preserve it: `??` keeps `""`, `|| ` collapses it.
   When in doubt, cover present / `null` / absent / `""` in a scenario and read the
   four outputs.

### Verify by VALUE, not bytes

A correct port round-trips, but **not** byte-for-byte: `jsonata()` pretty-prints its
`expression` by default (newlines + 2-space indent; an expert's hand-written JSONata
has its own layout), and the YAML key order / expression idiom will differ. So verify
by **value**, in this loop:

1. **`tsc --noEmit` first** (the load-bearing check — the typed DSL catches wrong
   refs, bad field names, misspelled inputs), then **`bun test`**.
2. **`tdk compile template.ts`** — read the YAML against the source *field by field*.
   Each `data` value must be a `${{ … }}` template; the `expression` must be a JSONata
   string (`$assert`/`:=`), never a `${{ }}`. A value that shows up as literal
   expression source where a `${{ }}` belongs is the tell-tale of a misplaced
   expression (pitfall 1/2). `tdk compile` also schema-validates by default.
3. **`tdk execute template.ts --json`** — run your `__fixtures__/scenarios.ts` and
   check each branch's output equals what the source YAML would produce.
4. For an expression-heavy port, prove **behavioural equivalence** to the source in a
   test rather than eyeballing: `assertExecuteAgainstGold(Tpl, sourceYaml, fixture)`
   (whole-run), `assertDifferentialJsonata(myJsonataExpr, sourceExpression, fixtures)`
   (the compiled `jsonata` vs the source's hand-written JSONata, value-for-value *and*
   throw-for-throw), or `assertDifferentialNj(myNjExpr, fixtures)` (render both with
   the real nunjucks engine). These assert *value*-equivalence, which is exactly what
   round-tripping means when the layouts legitimately differ.

**The feedback loop.** `tdk compile` compiles AND validates against the Backstage
schema by default (`--no-validate` to skip); `tdk execute` runs your scenarios and
prints each branch's JSON output. Compile to read the YAML, then execute to see the
values — that loop is how you catch a misplaced expression or a wrong branch. (`tdk
build` validates every artifact *before* it writes anything, so a broken port never
lands a half-written output tree.)

**Loud compile errors are on your side.** A whole class of porting mistakes **throws**
at compile instead of shipping green: a `jsonata(...)` used outside a roadie
`expression` (pitfall 2), a non-`Param` property value, a `showWhen` cycle or
collision with a `dep.when`/`rawDependencies` on the same controller, an unresolved
`env.pick`/resolver marker leaking into the artifact, an `extraSpec` key colliding
with a modeled `spec` field, a non-GA `lifecycle` missing `restrictedToUsers` (fails
closed), a duplicate step id or param name, and an `enumNames` length mismatch. If
`tdk compile` throws, read the message — it names the exact mistake; that's the
earliest place to catch it.
