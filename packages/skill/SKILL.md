---
name: tdk
description: Author and test Backstage Scaffolder templates in TypeScript with TDK (@tdk/core). Author a template as a dataflow graph of module-scope values — typed fields, computed derives, effects, pages and handle-based output — that compiles to schema-valid template YAML, and test it with scenario snapshots.
---

# TDK — authoring Backstage templates in TypeScript

TDK (`@tdk/core`) is a TypeScript DSL that **compiles** to a Backstage Scaffolder
`Template` entity (the `template.yaml`). You write typed module-scope values and a
`defineTemplate(...)` call; `compile` turns them into YAML, once per deploy target.
You never hand-write JSON Schema, JSONata, Nunjucks, or YAML.

Author a template as a **dataflow graph of module-scope values that reference each
other** (ADR-0025, "authoring v2"). You declare each field, each computed value and
each side effect as a named `const`; the compiler walks the graph, synthesises the
form schema, wires every reference, and orders the steps. This is the way to author
a new template. A lower-level primitive layer (`step()`, `dep.*`, an explicit
`steps:` list) still exists and still compiles — see the [v1 primitives
appendix](#appendix-the-v1-primitive-layer) for when you need it.

Use this skill to author a new template, extend one, or write its tests. The running
reference throughout is `examples/oven-support-v2` — the flagship v2 template.

## Mental model

A template is a plain **value** (no class, no `new`), assembled from module-scope
`const`s. The five moving parts:

1. **Fields** — typed form inputs, each a `const` with its own visibility.
2. **Derives** — runtime-computed values, each a function of other values.
3. **Effects** — side-effectful steps (a submit, a notification), each returning a
   typed handle.
4. **Pages** — the ordered table of contents that groups the fields.
5. **Output** — a plain map that reads effect and derive outputs by handle.

Here is the whole flagship, trimmed (`examples/oven-support-v2/template.ts`):

```ts
import { defineTemplate, derive, p, page } from "@tdk/core";
import { raiseTicket } from "./plugin.ts"; // a pack effect helper (below)

// --- Fields (module-scope consts, each with its own visibility) ---
export const bakeryCode = p.choice(
  { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
  { title: "Bakery site", required: true },
);
export const ovenId = p.string({ title: "Oven asset ID", required: true });
export const ovenType = p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true });
export const severity = p.choice(
  { low: "Low", normal: "Normal", urgent: "Urgent" },
  { title: "Severity", required: true },
);
export const problemArea = p.choice(["heating", "conveyor", "controls", "other"], {
  title: "Problem area",
  required: true,
});
// CONDITIONAL fields — each shown only for a specific controller value.
export const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));
export const urgentReason = p.string({ title: "Why is this urgent?" }).showWhen(severity.is("urgent"));
export const contactEmail = p.string({ title: "Who should we update?", format: "email", required: true });

// --- Derived values (computed from other values) ---
export const ticketTitle = derive(
  "ticket-title",
  { bakeryCode, ovenId, severity },
  (i) => `${i.severity === "urgent" ? "[URGENT] " : ""}Oven ${i.ovenId} at ${i.bakeryCode}`,
);
export const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
// `i.otherDetail` is `string | undefined` — the lambda handles the absence.
export const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);

// --- The effect (a pack helper returning a typed handle) ---
export const ticket = raiseTicket("open-oven-ticket", {
  title: ticketTitle,
  slaHours,
  summary: problemSummary,
  site: bakeryCode,
  oven: ovenId,
  ovenType,
  urgentReason: urgentReason.ref.orElse(""),
  contact: contactEmail,
});

export const OvenSupportRequestV2 = defineTemplate({
  id: "oven-support-request-v2",
  title: "Request oven support (v2)",
  description: "Raise an oven-support ticket, assembling its fields from the submitted form.",
  type: "service",
  tags: ["bakery", "oven", "support"],
  owner: "team-bakery",
  // Pages ARE the ordered table of contents; ui:order is inferred per page.
  pages: [
    page("Oven and site", { bakeryCode, ovenId, ovenType }),
    page("The problem", { severity, problemArea, otherDetail, urgentReason }),
    page("Contact", { contactEmail }),
  ],
  // Effects are the reachability roots; the three derives are pulled in through them.
  effects: [ticket],
  // Output reads the effect's output BY HANDLE — no hand-written step reference.
  output: {
    ticketUrl: ticket.output.body.url,
    ticketId: ticket.output.body.id,
  },
});
```

`defineTemplate({...})` returns a `TypedTemplate<…>` — a normal template that
`compile` / `compileResolved` / `compileAll` / `execute` and the CLI all consume, and
that carries a phantom of its params' shape so `execute()` fixtures type-check.

A v2 config declares `pages:` + `effects:`. It **must not** also declare `steps:` /
`parameters:` — mixing the two shapes is a type error and a loud runtime throw.

## Fields

Declare each field once, as a module-scope `const`, with a `p.*` builder. Reference
it later by the const itself (in a derive's inputs or an effect helper's args) or by
its `.ref` (in a `raw`/`nj`/`jsonata` expression). Field names come from the property
key in the `page(...)` map, and must be **unique across all pages** (the form is one
flat namespace — a duplicate throws).

### Field types (`p.*`)

| Builder | Use |
|---|---|
| `p.string({...})` | text; opts: `pattern`, `minLength`, `maxLength`, `format`, `default`, `uiWidget`, `uiOptions` |
| `p.choice([...])` or `p.choice({ value: label })` | dropdown — the sugar for `enum`/`enumNames`. Array form when value === label; object form when value ≠ label |
| `p.enum([...])` or `p.enum({ enum, enumNames }, ...)` | the raw enum builder `p.choice` desugars to; reach for `p.choice` first |
| `p.boolean({...})` | checkbox |
| `p.number({...})` | numeric; opts add `minimum`, `maximum` |
| `p.array({...})` | list; opts `items`, `minItems`, `maxItems` (`items` defaults to `{ type: "string" }`) |
| `p.customField({ type?, uiField, uiOptions })` | any Backstage custom field extension — `ui:field` + `ui:options` emitted verbatim. For a reusable typed helper, wrap it once with `defineField` in your shared pack code. |

Common options on every field: `title`, `description`, `required: true`, `default`,
`uiWidget` (→ `ui:widget`), `uiOptions` (→ `ui:options`), `errorMessage`, `showWhen`.

```ts
p.string({ title: "Bakery code", pattern: "^[A-Z]{2,10}$", required: true })
p.string({ title: "Details", uiWidget: "textarea", uiOptions: { rows: 5 } })
p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true })
p.choice({ BK1: "Riverside", BK2: "Old Town" }, { title: "Bakery site", required: true })
```

### `p.choice` — prefer it over hand-writing `enum`/`enumNames`

`p.choice` takes either the values alone (array form) or an object mapping each value
to its display label. The object form's keys become `enum` in written order; its
values become the parallel `enumNames`. The value is **typed**, so `.is()` / `.in()`
(and a scenario fixture's `parameters`) only accept a value from the declared set —
`severity.is("high")` is a compile error when the set is `low`/`normal`/`urgent`.

## Conditional fields — `.showWhen(predicate)`

Give a field its own visibility with `.showWhen(...)`. The predicate is per-field
equality or membership, built from a hoisted controller const:

- `controller.is(value)` — reveal in that value's branch (equality).
- `controller.in([a, b])` (or the variadic `controller.in(a, b)`) — OR on **one** field.
- `all(c1, c2)` — AND several predicates (from `@tdk/core`).
- `any(c1, c2)` — OR predicates **on one field** — identical to `.in([...])`.

```ts
import { all, p } from "@tdk/core";

const problemArea = p.choice(["heating", "conveyor", "controls", "other"], { title: "Problem area", required: true });
const severity = p.choice({ low: "Low", normal: "Normal", urgent: "Urgent" }, { title: "Severity", required: true });

const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));
// AND across two fields — auto-nests in the schema tree the compiler synthesises.
const escalationNote = p.string({ title: "Escalation note" })
  .showWhen(all(problemArea.is("other"), severity.in(["normal", "urgent"])));
```

The value is literal-checked in the editor: `severity.is("hi")` squiggles because the
controller carries its value type. The `showWhen:` constructor option is the same
feature (`p.string({ title: "…", showWhen: problemArea.is("other") })`) — pass a
predicate to whichever reads better; setting a field's visibility both ways throws.

The compiler synthesises the whole `dependencies`/`oneOf` tree — including every
empty else-branch the wire format needs — from these predicates. A conditional field
lives in `dependencies`, **not** in the page's base `properties`, so it is not listed
in that page's `ui:order`.

### Loud rejection — anticipate these compile throws

A restricted vocabulary compiles to the schema, so some shapes have no wire form and
throw at compile. Anticipate them:

- an `any(...)` OR spanning **different** fields — a JSON-Schema dependency keys off
  one controller, so a cross-field OR cannot be expressed. Use `.in([...])` for an OR
  on one field. (A cross-field OR *is* allowed in a run condition — see the asymmetry
  below.)
- a `showWhen` naming a controller that is not a property on the **same page** (each
  page is its own object schema — a cross-page reveal has no wire form).
- a `showWhen` cycle, or a `showWhen` that collides with a `dep.when` /
  `rawDependencies` on the same controller.

When you need a branch shape `showWhen` can't express (one body for several controller
values with per-value fields, chained reveals `showWhen` won't nest), drop to the
`dep.when` primitive on the page — see the [appendix](#appendix-the-v1-primitive-layer).

## Derives — `derive(name, inputs, fn)`

A derived value is a **cell in a spreadsheet**: a formula over other cells that
recomputes from its inputs. `derive` is that cell for a template — a runtime-computed
value defined as a function of fields and other derives.

```ts
const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
```

You pass three things:

- a `name` — **mandatory and explicit**. It is the step id and the value's name
  everywhere it is used, and Backstage shows it in the run log (title-cased:
  `"sla-hours"` → `Sla Hours`). Naming is intent, not ceremony. Pass `{ name: "…" }`
  as a fourth arg for a phrase the log should read verbatim.
- an `inputs` object — the cells this value reads. Each may be a field const (or its
  `.ref`), another derive's handle (or a sub-ref of one), an `nj(...)` marker reading
  a manual step's output, or a literal.
- a `fn` lambda — the formula, transpiled by the **same** TS→JSONata transpiler
  `jsonata(...)` uses. Author the TypeScript; never hand-write JSONata.

`derive` returns a typed handle. Use it anywhere a value goes — another derive's
inputs, an effect helper's args, or `output`. At compile TDK writes each reachable
derive as a `roadiehq:utils:jsonata` step (the `data:` map from your `inputs`, the
`expression:` from your lambda) and emits the
`${{ steps['sla-hours'].output.result }}` reference for you. You never write that
string, and you never state the inputs twice.

### The lambda context is inferred, and conditionality-aware

You do not write a `Ctx` type. The lambda's context comes from the `inputs` object:
each input maps to the value its cell holds. A field with a `showWhen` can be absent
at runtime, so it types as `T | undefined` inside the derive — the lambda **must**
handle the absence:

```ts
// otherDetail is conditional, so i.otherDetail is `string | undefined`.
const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);
```

Both spellings carry the `| undefined`: the `.showWhen(...)` method and the inline
`showWhen:` option. One caveat: the option only carries it when you pass the options
**inline**. An options object routed through a variable whose type has `showWhen`
optional still reveals the field at runtime but types as `T` — pass the options
inline, or use the method.

### Sub-refs — reading one field of an object result

When a derive returns an object, its handle exposes a typed handle per property:

```ts
const jira = derive("jira", { severity }, (i) => ({ summary: `sev ${i.severity}`, id: "T-1" }));
// jira.summary → ${{ steps['jira'].output.result.summary }}, typed as its field
```

Limits: arrays expose no per-element sub-ref (use the whole array handle); reserved
names (`render`, `toString`, `then`, `catch`, `finally`, `toJSON`, `valueOf`,
`constructor`, `prototype`, any `__`-prefixed) are not reachable; a sub-ref key must
be a plain identifier.

### Planning and the sharp edges

TDK collects every derive reachable from the effects and the `output`, then orders the
whole graph so each value comes after everything it reads (a topological sort). Three
conditions stop the compile or warn:

- a dependency **cycle** among derives — compile error, naming the cycle.
- two derives sharing a **name** — compile error (names are unique per template; a
  derive imported into two templates gets its own step in each).
- a declared derive that **nothing reaches** — left out of emission with a warning on
  `CompileResult.diagnostics`. Silent-to-loud: never dropped in silence.

### Testing a derive — mock its INPUTS, not the derive step

A derive is a `roadiehq:utils:jsonata` step, so `execute()` always evaluates its
expression **for real**. A fixture mock on a derive's step id is ignored. To steer a
derive in a scenario, set its **inputs** — the parameters and the upstream steps it
reads. (This is the contrast with an effect, whose non-jsonata action *does* defer to
a fixture mock — see [effects](#effects--the-pack-effect-helper-pattern) and
[mock-wins](#mock-wins--per-call-simulators).)

## Effects — the pack effect-helper pattern

An **effect** is a side-effectful step (a submit, a provision, a notification) that
returns a typed handle. `effect(id, action, opts)` is core's primitive; in practice a
**pack** publishes a typed helper that wraps it, exactly as a pack publishes typed
field helpers (`defineField`) and step helpers (`defineAction`). The helper is a
`defineAction`-style factory: it pins the action id and the output shape
(`effect<TicketOutput>`), and — like `defineAction`'s `simulate` — registers the
action's `execute()` simulator at import. Here is the flagship's pack
(`examples/oven-support-v2/plugin.ts`), trimmed:

```ts
import { type EffectHandle, type EffectInputValue, effect, registerActionSimulator } from "@tdk/core";

const RAISE_TICKET_ACTION = "bakery:raise-ticket";

/** The output shape the action returns — the effect handle's type `O`. */
export interface TicketOutput {
  body: { url: string; id: string };
}

/**
 * The typed args the helper accepts. Each is `EffectInputValue`, NOT `InputValue`.
 * `EffectInputValue` = `InputValue | ParamBase<unknown>` — so it also admits a BARE
 * param const, letting the author pass `site: bakeryCode` directly (the effect
 * normalizes it to `.ref`). Typing an arg as plain `InputValue` would REJECT a bare
 * const — the exact trap to avoid.
 */
export interface RaiseTicketArgs {
  title: EffectInputValue;
  summary: EffectInputValue;
  site: EffectInputValue;
  oven: EffectInputValue;
  urgentReason: EffectInputValue;
}

/** execute() simulator — the RENDERED input is `Record<string, unknown>`, so coerce
 *  each value (here `String(input.oven)`) before use. Registered at import. */
function simulateRaiseTicket(input: Record<string, unknown>): TicketOutput {
  const id = `TCK-${String(input.oven)}`;
  return { body: { id, url: `https://catalog.example/tickets/${id}` } };
}
registerActionSimulator(RAISE_TICKET_ACTION, simulateRaiseTicket);

/** The pack's effect helper — returns a typed `EffectHandle<TicketOutput>`. */
export function raiseTicket(id: string, args: RaiseTicketArgs): EffectHandle<TicketOutput> {
  return effect<TicketOutput>(id, RAISE_TICKET_ACTION, {
    name: "Raise the oven-support ticket",
    input: {
      title: args.title,
      summary: args.summary,
      site: args.site,
      oven: args.oven,
      urgentReason: args.urgentReason,
    },
  });
}
```

Two traps to internalise:

1. **A helper arg is `EffectInputValue`, never `InputValue`.** `EffectInputValue`
   admits a bare param const; `InputValue` does not. PR #26's review caught a doc
   snippet that typed the arg loosely — the documented call then rejected itself.
2. **A simulator's `input` is `Record<string, unknown>`.** A value read from it is
   `unknown`, so `` `TCK-${input.oven}` `` is a type error — coerce with
   `String(input.oven)` (or a cast) first.

### Using an effect

Call the helper at module scope; you get back an `EffectHandle<O>`. Its
`.output.<key>` sub-refs render `${{ steps['<id>'].output.<key> }}` and carry the
field's type, so `ticket.output.body.url` is a checked reference:

```ts
const ticket = raiseTicket("open-oven-ticket", {
  title: ticketTitle,          // a derive handle
  summary: problemSummary,     // a derive handle
  site: bakeryCode,            // a bare param const
  oven: ovenId,
  urgentReason: urgentReason.ref.orElse(""),  // a conditional field, defaulted
});
```

`urgentReason.ref.orElse("")` supplies the default the compiler would otherwise make
you defend by hand — it renders `${{ parameters.urgentReason | default("") }}`.
`.orElse` lives on the `.ref` (a `ParamRef`), not the bare const.

### `.when(...)`, `after`, and `rawEffect`

`effect(...)` and its helpers take `{ input?, name?, when?, if?, after? }`.

- `.when(predicate)` (or the `when:` option) makes an effect conditional, compiling to
  the step `if:` — `notify.when(severity.is("urgent"))` raises the notification only
  for urgent tickets. Giving both `when` and `if` throws.
- `after`/`.after(otherEffect)` states an order-only edge for two effects with no data
  dependency (data dependencies order themselves).
- `rawEffect(step)` wraps a pre-built `Step` (from a v1 `defineAction` helper or a
  hand-built object) as an effect — the escape hatch. Its type parameter types the
  `.output`; it drops straight into `effects:`.

## Pages — the ordered table of contents

`pages` is an ordered list of `page(title, props)`. It is the form's table of contents
**and** the params' name-binding site (the field name comes from the property key).
Field order within a page is source order, so each page's **`ui:order` is inferred**
and emitted explicitly (RJSF field order pinned to the authored TOC). Conditional
fields sit in `dependencies`, so they are excluded from `ui:order`.

```ts
pages: [
  page("Oven and site", { bakeryCode, ovenId, ovenType }),
  page("The problem", { severity, problemArea, otherDetail, urgentReason }),
  page("Contact", { contactEmail }),
],
```

Pass a page's third arg `{ uiOrder }` to override the inference. A page can also carry
`rawDependencies` / `rawSchema` (verbatim JSON-Schema merge points) for shapes TDK
does not model.

### Reusable pages (fragments)

`fragment(title, props)` (from `@tdk/core`) builds a reusable colocated **page** —
authored once, dropped into many templates. A fragment is just a `page` value, so
compose it into `pages:` like any page. Concrete org fragments live in **your** shared
pack code, not in `@tdk/core` (core ships only the `fragment()` mechanism). A common
org rule is a **Baking Justification** page — a single-field page built with
`fragment()`, composed **last**:

```ts
import { bakingJustificationPage } from "../_shared/fragments"; // YOUR shared fragment

pages: [
  page("Oven and site", { bakeryCode, ovenId }),
  bakingJustificationPage(),   // a single-field page; MUST be the LAST page
],
```

That fragment contributes a field named **`baking_justification`** (snake_case) —
reference it as the const the fragment exports. Add it **only when the requirements
ask for one**.

## Output — a plain map of handles

In v2 `output` is a plain object (not a function of `f`), because the fields are
module-scope consts. It reads effect and derive outputs **by handle**, so no
`${{ steps[...] }}` string is written by hand:

```ts
output: {
  ticketUrl: ticket.output.body.url,   // effect sub-ref
  ticketId: ticket.output.body.id,
  sla: slaHours,                        // a derive handle reads as its result
},
```

`output` is also a **reachability root**: a derive referenced only by `output` (no
effect touches it) is still collected. When `output` holds heterogeneous lists,
annotate the value with `InputValue` types so TS checks element-wise.

## `.when()` / `any()` — the form-vs-condition asymmetry

The same typed predicates (`field.is`, `field.in`, `all`, `any`) serve two layers, and
they differ on **one** point:

- **Form layer** — a field's `showWhen`. `any(...)` must test the **same** field; a
  cross-field OR throws (JSON-Schema keys a dependency off one controller).
- **Condition layer** — a step's / effect's `when` (and `.when()`), compiling to `if:`.
  Here `any(...)` **may** span different fields, because the condition is Nunjucks,
  which has `or`. `all(x, any(y, z))` nests as `(x) and ((y) or (z))`.

Same vocabulary, two layers; only a cross-field `any(...)` differs. State this to
yourself before reaching for `any` — it is legal in a `when`, rejected in a `showWhen`.

## Expressions — `raw`, `nj`, `jsonata`

Most values flow through fields, derives and handles. When you need a raw expression:

- **`raw`** — a verbatim Scaffolder string interpolating typed refs
  (`` raw`https://bakery.example/orders/${bakeryCode.ref}` ``). Use it for a **single**
  static/interpolated string with no logic. Never put a `let` / `$assert` / a ternary
  / multiple statements inside `raw` — that is the #1 source of broken templates.
- **`nj((c) => …)`** — TypeScript → Nunjucks `${{ … }}`. Use for templating that reads
  the run context `c`.
- **`jsonata((c) => …)`** — TypeScript → JSONata, for `roadiehq:utils:jsonata` steps
  and richer transforms (block bodies, `$assert`, array ops). Prefer a **derive** —
  which uses this exact transpiler — over a hand-built roadie step.

Author in TS; **never hand-write a JSONata/Nunjucks string**. The transpiler gets the
references and root right; a hand-written string usually has the wrong root and won't
be checked. Both dialects have differential test harnesses behind them.

### The run context `c` (inside `nj` / `jsonata`)

- `c.parameters.<name>` — a submitted form value.
- `c.steps["<step-id>"].output.<key>` — a previous step's output. **Note the
  `.output`**: `c.steps["fetch-user"].output.result`, not `.result`.
- `c.secrets.<name>`, and `c.user` (e.g. `c.user.entity.metadata.name`, `c.user.ref`).

### `roadiehq:utils:jsonata` steps — the `data`-vs-`expression` trap

This action evaluates a JSONata `expression` whose **root is the step's `data`**. So
inside the `jsonata`, read the data fields **bare** — `c.foo` compiles to `foo`, not
`data.foo`. Build `data` with `nj`, the `expression` with a typed `jsonata`:

```ts
type PayloadCtx = { flavor: string; size: string };
const payload = jsonata<PayloadCtx>((c) => ({ summary: `CAKE - ${c.flavor} - ${c.size}` }));

step("compute", "roadiehq:utils:jsonata", {
  input: {
    data: { flavor: nj((c) => c.parameters.flavor), size: nj((c) => c.parameters.size) },
    expression: payload.jsonata,   // ← the compiled JSONata string
  },
});
```

**`data` values are `nj`, NEVER `jsonata`.** Every `data` field is a Scaffolder
`${{ … }}` template resolved *before* the expression runs, so a `jsonata(...)` dropped
into `data` renders as an inert literal string (never executed) and ships green — a
silent failure. Only the step's `expression` is ever `jsonata`. In v2 you rarely write
this step by hand — a **derive** generates it — but the trap still bites if you do.

### Procedural expressions — a block body, never `raw`

Guards, intermediate values and conditional assembly belong inside a `jsonata`
**block body** `(c) => { … return … }` (or a derive lambda). The transpiler emits the
correct dialect: `require(cond, msg)` / `assert(cond, msg)` → `$assert(…)`,
`const x = …` → `$x := …`, ternaries, template literals → `&`. **The trap:** JSONata
has **no `let`** — binding is `$x :=` — so a hand-written `` raw`( let x := … )` `` is a
silent parse error that ships green.

```ts
type OrderCtx = { headBaker: string; priority: string; filling?: string };
const orderPayload = jsonata<OrderCtx>((c) => {
  require(c.headBaker !== "", "The head baker could not be resolved."); // → $assert(…)
  const fillingLine = c.filling ? `Filling: ${c.filling}\n` : "";       // conditional line
  const stages =
    c.priority === "High"
      ? [{ identifier: "Head Baker", approvers: [c.headBaker] }]
      : [{ identifier: "Baker", approvers: [c.headBaker] }];
  return { orderNotes: fillingLine, approvalChain: stages };
});
```

`require(cond, msg)` is an alias of `assert`, read as a sentence — reach for it in new
code. The step's **output is `{ result: <the value> }`**, read later as
`c.steps["compute"].output.result`.

## Per-environment values — `env.pick`

A template compiles once per target env. Env names are open strings. `env.pick`
resolves to the matching value (or a reserved `default` fallback), giving
environment-safety by construction; compiling for an env a pick doesn't know (with no
`default`) throws, naming the known envs and the miss:

```ts
import { env } from "@tdk/core";
// in an effect helper's args or a step input:
const cluster = env.pick({ test: "test-cluster", prod: "prod-cluster" });   // two envs
const region = env.pick({ prod: "eu-west", default: "eu-central" });        // default fallback
```

## Compile-time data — `load()`

Fetch external data **at compile time** and bake it into the form as real options.
`load({ env })` is env-aware, so each target can bake different options. Its result
feeds the form, which then takes a function form. Because the form must see the loaded
options at its name-binding site, a `load()` template stays on the v1 `parameters:
(data) => [...]` shape (below) — `load()` is otherwise orthogonal and its steps/output
can still be authored the v2 way once the form is built:

```ts
import { defineTemplate, type LoadContext, p, page, step } from "@tdk/core";
import { bakery } from "./clients";

export const load = async ({ env }: LoadContext) => ({ flavors: await bakery.flavors(env) });

export const OrderCake = defineTemplate({
  id: "order-cake", title: "Order a Cake", type: "service",
  load,
  parameters: (data) => [                                   // data: { flavors: string[] }
    page("Cake", { flavor: p.choice(data.flavors, { title: "Flavour", required: true }) }),
  ],
  steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
});
```

A `load()` template must compile via the async path (`compileResolved` /
`compileAll` / `execute`); the synchronous `compile()` throws. **Mocking** is two-tier:
a scenario fixture's `loaded: {…}` injects data (skips `load()`, deterministic); or
MSW/`Bun.serve` fakes the network while real `load()` runs.

## Testing

Simulate a run with `execute(template, fixture)` — it renders interpolations and runs
the pure (jsonata) steps; external actions run through their registered simulator or a
fixture mock.

```ts
import { execute } from "@tdk/core";

const run = await execute(OvenSupportRequestV2, {
  parameters: {
    bakeryCode: "BK1", ovenId: "OV-9", ovenType: "deck",
    severity: "normal", problemArea: "heating", contactEmail: "x@y.example",
  },
  // steps: { "open-oven-ticket": { output: { body: { id: "M", url: "…" } } } }, // optional mock
});
```

`execute`'s results are typed `unknown` (the run context is dynamic). Assert on the
WHOLE value with `toEqual`, or CAST before any property access — never
`run.output.ticketUrl` directly (a TS18046 'unknown' error). Pick the env with the 3rd
arg — shape `{ target }`, not `{ env }`:
`await execute(tpl, fixture, { target: { env: "prod", outDir: "" } })`.

### Scenarios and snapshots

Put scenarios in `__fixtures__/scenarios.ts` and snapshot them with `tdk test`:

```ts
import type { ExecuteFixture } from "@tdk/core";
type OvenParams = {
  bakeryCode: "BK1" | "BK2" | "BK3"; ovenId: string; ovenType: "deck" | "convection" | "rack";
  severity: "low" | "normal" | "urgent"; problemArea: "heating" | "conveyor" | "controls" | "other";
  otherDetail?: string; urgentReason?: string; contactEmail: string;
} & Record<string, unknown>;

export const scenarios: { name: string; branches?: string[]; fixture: ExecuteFixture<OvenParams> }[] = [
  {
    name: "normal — heating problem, ticket simulated",
    branches: ["normal", "heating"],
    fixture: {
      parameters: {
        bakeryCode: "BK2", ovenId: "OV-1200", ovenType: "convection",
        severity: "normal", problemArea: "heating", contactEmail: "ops@oldtown.example",
      },
      // No mock — the pack's registered simulator computes the receipt from input.
    },
  },
];
```

- `tdk test` runs every scenario and snapshots its output at
  `__snapshots__/scenarios.snap` — a **sibling** of `__fixtures__/`, never nested, one
  file per template. First run writes (`+ written`); later runs compare (`✓ passed` /
  `✗ failed` + diff). `tdk test -u` accepts changes; `--ci` fails on a missing
  snapshot and never writes. Commit `__snapshots__/` — it is the regression baseline.
- The same engine drives the VS Code Test Explorer (native Testing view): suites are
  templates, tests are scenarios.

### Halt semantics

**Halt at the first failed step.** A step that ends with an `error` — a jsonata
`$assert`/expression that throws, an input that fails to render, or an action
simulator that throws — halts the run, like real Backstage: later steps are
`{ notReached: true }` (never rendered, no output) and the template `output` is
`undefined`. A falsy `if:` `skipped` step does **not** halt — steps after it still run.
A `notReached` step is distinct from a `skipped` one.

### Mock-wins + per-call simulators

An explicit fixture mock always **wins** over a registered action simulator (specific
beats general). The full precedence, most specific first: `fixture.steps[id]` mock →
a per-call simulator passed via `execute`'s `{ simulators }` option → the process-global
`registerActionSimulator` registry → `undefined`. So to test a simulated action's real
behaviour, leave its mock off; to pin a step's output regardless, supply the mock. A
**derive** never defers to a mock (its jsonata always evaluates); an **effect** (a
non-jsonata action) does — that is why you mock effect inputs vs. derive inputs
differently.

### Read what you compiled

`tsc` and `bun test` prove your template is *internally consistent* — they never run
the compiled JSONata/Nunjucks, so a semantically-wrong expression passes both.

- **`tsc --noEmit` is the most valuable check — always run it FIRST.** TDK's types
  catch wrong field names, missing/misspelled inputs, and bad refs. **`bun test` does
  NOT typecheck** (Bun erases types), so a type error silently becomes `undefined`.
  Verify in a loop: typecheck, then `bun test`.
- **`tdk compile template.ts`** prints the compiled YAML (and schema-validates by
  default). Read each step: `data` values must be `${{ … }}`; the top-level
  `expression` is a JSONata string. A value showing as literal expression source
  (`$…`, `:=`) where a `${{ }}` belongs is a misplaced expression.
- **`tdk execute template.ts --json`** runs your scenarios and prints each branch's
  output — check every branch against the ticket.
- `validate(object)` schema-checks a compiled entity; `compileResolved(tpl, target)`
  (async) is required for `load()`/marker templates (sync `compile` throws on them).

## The gold-standard oracle discipline

For a template whose behaviour matters, hand-write a `gold-standard.yaml` — what a
Backstage expert would author for the same behaviour — **before** you compile the TDK
template, and prove the two agree by **value** (not bytes):

- `assertExecuteAgainstGold(Tpl, goldYaml, fixture)` — whole-run agreement per scenario.
- `assertDifferentialJsonata(getDeriveExpr(myDerive), goldExpr, fixtures)` — a derive's
  transpiled JSONata against the gold's hand-written JSONata, value-for-value and
  throw-for-throw (via the same harness `jsonata()` uses).
- `assertDifferentialNj(myNjExpr, fixtures)` — render both with the real nunjucks engine.

The hand formatting differs from the pretty-printer **on purpose** — a byte-identical
gold would prove circularity, not correctness. `examples/oven-support-v2` is the
worked reference: derives proven by differential, the effect proven by execute-vs-gold,
`ui:order` inference and handle-based output pinned structurally.

## Rules (must follow)

1. **Author v2.** Module-scope fields, `derive`, effect helpers, `pages`, handle-based
   `output`. Reach for the v1 primitives only for a shape v2 can't express (appendix).
2. **Param names are unique across all pages** (one flat namespace).
3. **A conditional field's derive input is `T | undefined`** — handle the absence in
   the lambda; do not pretend it is always present.
4. **A pack effect-helper arg is `EffectInputValue`**, never `InputValue` — so a bare
   param const is accepted. A simulator's `input` value is `unknown` — coerce it.
5. **Per-env values use `env.pick`**, never hardcode another env's value.
6. **Baking Justification — only when the requirements ask for one**, and as the single
   field on the **last** page.
7. **Restrict a non-GA template** via `lifecycle: { state: "uat", restrictedToUsers: [...] }`.
8. **Never hand-write a JSONata/Nunjucks/YAML string.** Author with `jsonata(...)` /
   `nj(...)` / a derive lambda. `raw` is ONLY a single verbatim string with no logic.

## Porting a legacy YAML template to v2

Given a hand-written (or generated) Backstage Scaffolder `Template` YAML, port it to a
**v2 TDK source**. The YAML hands you the structure, so this is a mechanical
translation, not a redesign — a faithful port **round-trips** by *value* (the layout
differs; verify by value, not bytes). Work top to bottom.

### The section-by-section map (YAML → v2 source)

| YAML | v2 TDK |
|---|---|
| `metadata.name` / `title` / `description` / `spec.type` / `spec.owner` / `metadata.tags` | `defineTemplate({ id, title, description, type, owner, tags })` (`metadata.name` → `id`) |
| `spec.parameters` — an array of step objects (each = one page) | `pages: [page(title, { … })]` — a value; each page's fields are module-scope consts referenced here |
| a property `{ type: string, title, default, pattern, minLength, maxLength, format }` | a `const x = p.string({ … })` |
| a property with `enum` (+ optional `enumNames`) | `p.choice(["a","b"], opts)` (labels == values) or `p.choice({ a: "A", b: "B" }, opts)` (value ≠ label) |
| `type: boolean` / `number` / `array` | `p.boolean(...)` / `p.number(...)` / `p.array(...)` |
| a property in the step's `required: [...]` | `required: true` on that `p.*` const |
| `ui:widget` / `ui:options` / `ui:field` | `uiWidget` / `uiOptions` / `p.customField({ uiField, uiOptions })` |
| a property `if:` reveal, or `dependencies: { ctrl: { oneOf } }` | `const x = p.string({…}).showWhen(ctrl.is(value))` (or `.in([...])`, `all(...)`) |
| a `dependencies` tree `showWhen` can't shape | `dep.when(...)` on the page (appendix) |
| a `${{ … }}` computed value / a `roadiehq:utils:jsonata` step | a **`derive(name, inputs, fn)`** — the inputs are the fields it reads, the lambda is the formula. Consume its handle wherever the YAML interpolated the step output. |
| a side-effect step (`http`, a submit, a provision) | an **effect** — a pack helper returning a typed handle, listed in `effects:` |
| `${{ steps.s.output.k }}` in a later input | consume the producing derive/effect **handle** (`s.output.k`) — never a hand-written string |
| a value that differs per environment | `env.pick({ test: …, prod: … })` |
| `spec.output` | `output: { … }` — a plain map of handles/sub-refs/literals |
| a step `if:` condition | `.when(pred)` on the effect (or `if:` for a raw string) |
| anything with no typed equivalent | `raw` (single verbatim string), `rawEffect(step)`, or `rawDependencies`/`rawSchema` |

### Pitfalls the repo learned the hard way

1. **A `roadiehq:utils:jsonata` `data:` value is `nj`, NEVER `jsonata`** (a derive
   handles this for you — prefer it).
2. **Never use `jsonata()` as a plain step-input value** — it belongs only as a roadie
   `expression`. A bare `jsonata(...)` elsewhere throws at compile. For a computed
   input value use `nj((c) => …)`, or a derive.
3. **`||` / `&&` are value-preserving** — `c.name || "?"` yields the name, `c.unitPrice || 0`
   the price. Port `${{ x or y }}` straight to `c.x || c.y`.
4. **`??` is null-aware; `||` is not — and `""` is a third outcome.** `c.slot ?? "d"`
   falls back on null/absent but lets a present `""` through; `c.slot || "d"` also
   collapses `""` and `0`. Match whichever the source used.
5. **`parseInt`/`parseFloat` are lenient shims; no numeric prefix → *missing*, not
   NaN** (JSONata has no NaN), so a downstream `?` guard treats it as absent.

### Verify by VALUE, not bytes

1. **`tsc --noEmit` first**, then **`bun test`**.
2. **`tdk compile template.ts`** — read the YAML field by field against the source.
3. **`tdk execute template.ts --json`** — check each scenario branch against the source.
4. For an expression-heavy port, prove **behavioural equivalence** with
   `assertExecuteAgainstGold` / `assertDifferentialJsonata` / `assertDifferentialNj`
   rather than eyeballing.

**Loud compile errors are on your side.** A whole class of porting mistakes throws
instead of shipping green: a `jsonata(...)` outside a roadie `expression`, a
`showWhen` cross-field OR / cycle / collision, an unreachable derive (warns), a
duplicate derive/step id or param name, an unresolved `env.pick`/resolver marker in the
artifact, an `enumNames` length mismatch, a non-GA `lifecycle` without
`restrictedToUsers`, a v2 config that also declares `steps:`/`parameters:`. If a
command throws, read the message — it names the exact mistake.

## Appendix: the v1 primitive layer

The v2 surface compiles **through** an older primitive layer that still exists and
still compiles, byte-for-byte unchanged. Reach for it only when v2 can't express a
shape — a scaffolding step with no data flow, an exotic dependency tree, a hand-built
input. It will be removed in a pre-1.0 breaking bump, so do not author new templates on
it wholesale.

- **`defineTemplate({ parameters, steps, output })`** — the v1 config. `parameters` is
  a flat props object or an array of `page(...)`; `steps: (f) => Step[]` receives the
  typed field-ref map `f` (`f.<name>` is a param's `.ref`); `output: (f) => ({…})`.
  Use it for a `load()` template (`parameters: (data) => [...]`) whose form must see the
  loaded options.
- **`step(id, action, { input?, name?, if?, when? })`** — one step. `input` values are
  `f.<param>` refs, `env.pick`, `raw`/`nj`/`jsonata`, or literals. `when` takes the same
  typed predicates as an effect's `.when`.
- **`dep.when(controller, [ dep.eq(v, body), dep.oneOf([...], body), dep.not(v, body) ])`**
  — the JSON-Schema `dependencies` builder for branch shapes `showWhen` can't express
  (one body for several controller values, `not`, chained reveals). `rawDependencies` /
  `rawSchema` on a page are the raw JSON-Schema passthroughs.
- **`raw`** — a verbatim Scaffolder string (a URL, a literal ref). Never logic.

A v1 template's `steps:` may mix manual `step(...)` calls with derive handles: a derive
reachable from a manual step's `output` is collected and planned between the step that
produces its inputs and the step that reads it. But new work should declare `effects:`
and let the planner collect everything.
