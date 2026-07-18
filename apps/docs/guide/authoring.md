# Author a template

A template is a plain value — no class, no `new`. You author it as a **dataflow graph
of module-scope values that reference each other**: each field, each computed value and
each side effect is a named `const`, and `defineTemplate({...})` ties them together with
the metadata, the `pages`, the `effects` and the `output`. The compiler walks the graph,
synthesises the form schema, wires every reference, and orders the steps.

```ts
import { defineTemplate, derive, p, page } from "@tdk/core";
import { raiseTicket } from "./plugin.ts"; // a pack effect helper (below)

// Fields — module-scope consts, each with its own visibility.
const bakeryCode = p.choice({ BK1: "Riverside", BK2: "Old Town" }, { title: "Bakery site", required: true });
const ovenId = p.string({ title: "Oven asset ID", required: true });
const severity = p.choice({ low: "Low", normal: "Normal", urgent: "Urgent" }, { title: "Severity", required: true });
const problemArea = p.choice(["heating", "controls", "other"], { title: "Problem area", required: true });
const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));

// Derives — computed values, each a function of other values.
const ticketTitle = derive("ticket-title", { bakeryCode, ovenId, severity }, (i) =>
  `${i.severity === "urgent" ? "[URGENT] " : ""}Oven ${i.ovenId} at ${i.bakeryCode}`,
);
const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);

// One effect — a pack helper returning a typed handle.
const ticket = raiseTicket("open-oven-ticket", {
  title: ticketTitle,
  summary: problemSummary,
  site: bakeryCode,
  oven: ovenId,
});

export default defineTemplate({
  id: "oven-support-request",
  title: "Request oven support",
  type: "service",
  pages: [
    page("Oven and site", { bakeryCode, ovenId }),
    page("The problem", { severity, problemArea, otherDetail }),
  ],
  effects: [ticket],
  output: {
    ticketUrl: ticket.output.body.url,
    ticketId: ticket.output.body.id,
  },
});
```

`defineTemplate(...)` returns a `TypedTemplate<…>` — a normal template that `compile` /
`compileResolved` / `compileAll` / `execute` and the CLI all consume unchanged, and that
carries a phantom of its params' shape so `execute()` fixtures type-check against it.

The whole worked template above lives at `examples/oven-support-v2` — the flagship v2
template, referenced throughout this guide.

## The `defineTemplate({...})` fields

| Field | Maps to | Notes |
| --- | --- | --- |
| `id` | `metadata.name` | required, unique in the catalog |
| `title` | `metadata.title` | required |
| `description` | `metadata.description` | optional |
| `type` | `spec.type` | required, e.g. `service` |
| `tags` | `metadata.tags` | optional |
| `owner` | `spec.owner` | optional |
| `lifecycle` | `spec.restrictedToUsers` | `{ state, restrictedToUsers? }`; see [Lifecycle gating](#lifecycle-gating) |
| `extraSpec` | `spec.*` | arbitrary extra top-level `spec` keys (escape hatch) |
| `pages` | `spec.parameters` | an ordered array of `page(title, props)`; each page's `ui:order` is inferred from source order |
| `effects` | `spec.steps` | the reachability roots; steps (effects + referenced derives) are collected and ordered |
| `output` | `spec.output` | a plain `Record<string, InputValue>` of handles / sub-refs / refs / literals |
| `load` | — | optional compile-time data loader; then the form is a function of the loaded data |

A v2 config declares `pages:` + `effects:`. It **must not** also declare `steps:` /
`parameters:` — mixing the two shapes is a type error and a loud runtime throw. The older
`{ parameters, steps, output }` shape still compiles for the cases that need it; see the
[v1 primitive layer](#compatibility-the-v1-primitive-layer).

Under the hood `defineTemplate` returns an internal `Template` (the base model). Authors
use `defineTemplate` — never `class extends Template` — because the functional form is the
supported authoring surface.

## `p.*` — typed parameters

Each field is a module-scope `const` built with a `p.*` helper. The helpers are
`p.string`, `p.number`, `p.boolean`, `p.choice`, `p.enum`, `p.array` and `p.customField`.
Common options on every field are `{ title?, description?, required?, default?, uiField?,
uiWidget?, uiPlaceholder?, uiOptions?, showWhen?, errorMessage? }` plus type-specific ones.
Each param emits the right JSON-Schema fragment (type-level keys and colocated `ui:*`
keys), carries TS type info, exposes `.ref` (→ <code v-pre>${{ parameters.&lt;name&gt; }}</code>),
and is collected into `required` when `required: true`.

- `p.string` — `{ pattern?, minLength?, maxLength?, enum?, enumNames?, format? }`.
- `p.number` — `{ minimum?, maximum?, enum?, enumNames? }`.
- `p.boolean` — the common options only.
- `p.choice(values[], opts?)` or `p.choice({ value: label, … }, opts?)` — a dropdown, the
  sugar over `enum`/`enumNames`. Prefer this over hand-writing `enum`/`enumNames`.
- `p.enum(values[], extra?)` or `p.enum(optsObject)` — the raw enum builder `p.choice`
  desugars to. Pass the values as a bare array (optionally with an `extra` options object),
  or the full `{ enum, enumNames?, … }` object. Passing an options object and an `extra`
  arg is a type error (the overloads reject it).
- `p.array` — `{ items?, minItems?, maxItems? }` (`items` defaults to `{ type: "string" }`).

`enumNames` is a parallel display-label array. It is valid only on `string`/`number`/`enum`
options, requires `enum`, and its length must match `enum` — a mismatch throws at compile.

```ts
p.string({ title: "Bakery code", pattern: "^[A-Z]{2,10}$", required: true })
p.string({ title: "Details", uiWidget: "textarea", uiOptions: { rows: 5 } })
p.string({ title: "Deliver by", format: "date" })
p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true })
p.array({ items: { type: "string" }, minItems: 1 })
```

### `p.choice` — sugar for `enum`/`enumNames`

`p.choice` takes either the values on their own, or an object mapping each value to its
display label:

```ts
p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true })
p.choice({ BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" }, { title: "Bakery site" })
```

The object form's keys become `enum`, in the order they are written; its values become the
parallel `enumNames`. Both forms compile to exactly the same JSON Schema a hand-written
`p.string({ enum, enumNames })` would produce. The value is typed, so `.is()`/`.in()` (and
a scenario fixture's `parameters`) only accept a value from the set you declared:

```ts
const bakeryCode = p.choice({ BK1: "Riverside", BK2: "Old Town" }, { title: "Bakery site" });
bakeryCode.is("BK1");  // ok
bakeryCode.is("BK3");  // a compile error — "BK3" is not one of the declared values
```

This is the desugared equivalent, written by hand:

```ts
p.string({
  title: "Bakery site",
  enum: ["BK1", "BK2"],
  enumNames: ["Riverside", "Old Town"],
})
```

### Custom field-type helpers

Backstage custom field extensions are the escape hatch. `p.customField` emits `ui:field`
and `ui:options` verbatim for any field type your Backstage app registers:

```ts
p.customField({
  title: "Cake picker", required: true, uiField: "CakePickerWithDefault",
  uiOptions: { path: "bakery-catalog/cakes", valueSelector: "metadata.name", labelSelector: "metadata.name" },
})
// { type: "string", "ui:field": "CakePickerWithDefault", "ui:options": { … } }
// (pass `type` to override the default "string", e.g. type: "object".)
```

For a reusable, typed helper over a custom field, see `defineField` in
[Extend TDK](/guide/extending).

### `errorMessage` — human validation messages

By default the form shows ajv's raw phrasing — <span v-pre>`must have required property 'Contact
email'`</span>, `must match format "email"`. `errorMessage` replaces those with a message
you write, emitted as the [ajv-errors](https://github.com/ajv-validator/ajv-errors)
`errorMessage` keyword. The form preview renders it (its validator enables ajv-errors), and
so does Backstage's own Scaffolder form.

Two forms:

- a **string** — one message covering every way the field can be invalid, `required`
  included. The common case: one line that reads whether the field is empty or malformed.
- a keyword-keyed **object** — `{ pattern?, format?, minLength?, minimum?, enum?, required?,
  … }`, a message per keyword. Any keyword you leave out falls back to ajv's default text.

```ts
// one message for every failure (missing OR malformed):
p.string({ title: "Contact email", format: "email", required: true,
  errorMessage: "Enter a valid contact email." })

// per-keyword messages:
p.string({ title: "Bakery code", pattern: "^[A-Z]{2,10}$", required: true,
  errorMessage: { pattern: "Two to ten capital letters.", required: "The bakery code is required." } })
```

A field's `required` failure fires against the object schema, not the field, so its message
can't live on the field. TDK lifts it for you: a `required` message (the string form's whole
message, or the object form's `required` key) is emitted on the enclosing page — or, for a
`showWhen`/`dep.when` field, on the branch that reveals it — as
<span v-pre>`errorMessage: { required: { <field>: "…" } }`</span>. The message follows the
FINAL required list: it applies when the field ends up required, whether from its own
`required: true` or a page-level `required: [...]` override — and is dropped when the field
ends up optional (no failure to relabel).

## Conditional fields — `showWhen`

Give each field its own visibility with `.showWhen(predicate)`. The predicate is per-field
equality or membership, built from a hoisted controller const. Because a controller carries
its own value type, `severity.is("hi")` is a TypeScript error in your editor — not just at
compile:

```ts
import { all, p, page } from "@tdk/core";

const problemArea = p.choice(["heating", "conveyor", "controls", "other"], { title: "Problem area", required: true });
const severity = p.choice({ low: "Low", normal: "Normal", urgent: "Urgent" }, { title: "Severity", required: true });

const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));
// AND across two fields — auto-nests in the schema tree the compiler synthesises.
const escalationNote = p.string({ title: "Escalation note" })
  .showWhen(all(problemArea.is("other"), severity.in(["normal", "urgent"])));

page("The problem", { severity, problemArea, otherDetail, escalationNote });
```

- `controller.is(value)` reveals the field in that value's branch (equality).
- `controller.in([a, b])` reveals it across several branches (OR on one field). The
  variadic `controller.in(a, b)` is the same thing.
- `all(c1, c2)` ANDs predicates — the field appears only when both hold.
- `any(size.is("M"), size.is("L"))` ORs predicates on ONE field — the same as
  `size.in(["M", "L"])`, read as a disjunction. Every branch must test the same field.
- The value is literal-checked: a `p.choice`/`p.enum` accepts only its own values, a
  `p.boolean` accepts only `true`/`false`.
- The predicate carries the controller instance, so compile resolves its name — the
  reference survives renaming the property key.

`.showWhen(...)` and the `showWhen:` option are the same feature — pass a predicate to
whichever reads better. Set a field's visibility once: declaring it both ways throws. The
record form is the inline shorthand — no hoisting, backed by the same compile check (a
mistyped value fails at compile, not in the editor):

```ts
page("Cake & Decoration", {
  style: p.enum(["Layered", "Cupcakes"], { required: true }),
  topper: p.enum(["Custom", "Standard"], { showWhen: { style: "Layered" } }),
  topper_text: p.string({ required: true, showWhen: { style: "Layered", topper: "Custom" } }), // AND → auto-nested
});
```

- `showWhen: { ctrl: value }` reveals the field in `ctrl`'s `value` branch.
- Multiple keys mean AND; an array value means OR
  (`showWhen: { env: ["PROD", "TEST"] }` reveals it in both branches).

The compiler synthesises the whole `dependencies`/`oneOf` tree — including every empty
else-branch the wire format needs — from these predicates. In either form:

- branches cover the controller's full value set — its `enum`, or `true`/`false` for a
  boolean; values with no revealed field get an empty branch
- if a field's controller is itself conditional, its dependency auto-nests inside that
  controller's branch
- a conditional field lives in `dependencies`, **not** in the page's base `properties`, so
  it is not listed in that page's `ui:order`

A `showWhen` referencing a controller that is not a property on the same page (a cross-page
reveal has no wire form), an `any(...)` OR across different fields, a `showWhen` cycle, and
a `showWhen` colliding with a `dep.when` on the same controller all throw at compile (see
[Compile fails loudly](#compile-fails-loudly)). For branch shapes `showWhen` can't express —
one body for several controller values, chained reveals — drop to the `dep.when` primitive
on the page (see the [v1 primitive layer](#compatibility-the-v1-primitive-layer)).

## `when` — conditional effects and steps

An effect (or a v1 step) runs only when its `when` predicate holds. `when` takes the same
typed predicates a field's `showWhen` does — `field.is(v)`, `field.in(a, b)`, `all(...)`,
`any(...)` — and compiles them to the Nunjucks boolean string an `if:` needs. Hoist the
controller to a const so `when` and a field's `showWhen` can share it:

```ts
const severity = p.choice(["low", "normal", "urgent"], { title: "Severity", required: true });

// on an effect (below): notify only for urgent tickets
const notify = effect("notify-oncall", "debug:log", {
  when: severity.is("urgent"),
  input: { message: "An urgent oven ticket was raised" },
});
// => if: '${{ parameters.severity == "urgent" }}'
```

- `field.is(v)` compiles to `==`.
- `field.in(a, b)` compiles to the Nunjucks `in` operator.
- `all(c1, c2)` compiles to `and`, each condition in its own parentheses.
- `any(c1, c2)` compiles to `or`, each condition in its own parentheses.

### The form-vs-condition asymmetry

The same vocabulary serves two layers, and they differ on one point. A **cross-field**
`any(...)` is allowed in a `when` — a step condition is Nunjucks, which has `or`, so
`any(site.is("BK1"), severity.is("urgent"))` becomes `(…) or (…)`. But a field's `showWhen`
still **rejects** a cross-field `any(...)`: a JSON-Schema dependency keys off one controller,
so the wire cannot express it. Same predicates, two layers; only a cross-field `any(...)`
differs (issue #24). For an OR on one field, use that field's `.in([...])` in both layers.

Giving both `if` and `when` throws — they say the same thing two ways, so pick one.

## `derive(name, inputs, fn)` — computed values

A derived value is a cell in a spreadsheet. You write a formula over other cells, name it,
and it recomputes itself from its inputs. `derive` is that cell for a template: a
runtime-computed value defined as a function of fields and other derived values.

```ts
const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
```

You pass three things:

- a `name` — the step id, and the value's name everywhere it is used. It is **mandatory and
  explicit** because Backstage shows it in the run log, title-cased (`"sla-hours"` → `Sla
  Hours`). Pass `{ name }` as a fourth arg for a phrase the log should read verbatim.
- an `inputs` object — the cells this value reads.
- a `fn` lambda — the formula, transpiled by the same TS→JSONata transpiler `jsonata(...)`
  uses.

`derive` returns a typed handle. Use the handle anywhere a value goes — an effect's args,
another derive's inputs, or `output`. At compile TDK writes each reachable derive as a
`roadiehq:utils:jsonata` step (the `data:` map from your `inputs`, the `expression:` from
your lambda) and emits the reference for you:

```yaml
- id: sla-hours
  action: roadiehq:utils:jsonata
  input:
    data:
      severity: ${{ parameters.severity }}
    expression: severity = "urgent" ? 4 : (severity = "normal" ? 24 : 72)
- id: open-oven-ticket
  action: bakery:raise-ticket
  input:
    slaHours: ${{ steps['sla-hours'].output.result }}
```

You never write the <code v-pre>${{ steps['sla-hours'].output.result }}</code> string, and
you never write the `data:` map twice. Compare this with the hand-written form in
[decision 2 of ADR-0025](/guide/decisions/0025-authoring-v2-dataflow-model), which states
the same fields as a type and again as data.

### The lambda's context is inferred

You do not write a `Ctx` type. The lambda's context comes from the `inputs` object: each
input maps to the value its cell holds. A `sla-hours` reading `{ severity }` gets
`i.severity` typed as the severity choice. Inputs can be:

- a field, either the param const (`severity`) or its ref (`f.severity`)
- another derive's handle, or a property of one (see sub-refs below)
- an `nj(...)` marker, to read a manual step's output
- a literal

### A conditional field is typed as possibly absent

A field with a `showWhen` (see [conditional fields](#conditional-fields-showwhen)) can be
absent at runtime, so it types as `T | undefined` inside a derive. The lambda has to handle
the absence:

```ts
// otherDetail is conditional, so i.otherDetail is `string | undefined`
const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);
```

Both ways of attaching the condition carry the `| undefined`: the `.showWhen(...)` method
and the `showWhen:` option. One caveat: the option only carries it when you pass the options
inline. An options object that travels through a variable whose type has `showWhen` optional
still reveals the field at runtime, but types as `T` — pass the options inline, or use the
method.

### Sub-refs — reading one field of an object-typed value

When a derive returns an object, its handle exposes a typed handle per property. Reading
`jira.summary` gives a reference to that field:

```ts
const jira = derive("jira", { severity }, (i) => ({ summary: `sev ${i.severity}`, id: "T-1" }));
// jira.summary → ${{ steps['jira'].output.result.summary }}, typed as its field
```

Sub-refs work one property at a time on object results, with these limits:

- arrays expose no per-element sub-ref — use the whole array handle
- a property named `render`, `toString`, `then`, `catch`, `finally`, `toJSON`, `valueOf`,
  `constructor`, `prototype`, or any `__`-prefixed name is not reachable as a sub-ref — the
  type omits it, so reaching one is a compile error
- a sub-ref key must be a plain identifier (letters, digits, `_`, `$`, not starting with a
  digit) — the key is spliced into the emitted <code v-pre>${{ }}</code> path, so any other
  key throws at the access site
- enumeration is asymmetric: `'a' in handle` is `false` and `Object.keys` lists only the
  marker's own members — sub-refs exist on access, not as own properties

### How the steps are ordered

TDK collects every derive reachable from the effects and the `output`, then orders the whole
graph so each value comes after everything it reads (a topological sort). A derive that reads
a manual step's output lands between that step and the step that reads the derive.

Three conditions stop the compile or warn you:

- a dependency cycle among derives is a compile error, naming the cycle
- two derives sharing a name is a compile error — names are unique per template
- a declared derive that nothing reaches is left out, with a warning on
  `CompileResult.diagnostics` — it is never dropped in silence

A derive imported into two templates gets its own step in each. Names are unique per
template, not across the workspace.

### Testing a derived value

In `execute()` scenarios, a fixture mock on a derive's step id is ignored —
`roadiehq:utils:jsonata` steps always evaluate their expression directly. Mock the derive's
inputs instead: the upstream steps and parameters it reads. (This is the contrast with an
effect, whose non-jsonata action *does* defer to a fixture mock.)

## `.orElse(default)` — fill in an absent ref

`<ref>.orElse(default)` is sugar for the Nunjucks `default` filter. It renders the default
value only when the parameter is genuinely absent (`undefined`) — a present empty string,
`0` or `false` still passes through unchanged. `.orElse` lives on a param's `.ref` (a
`ParamRef`), so call it on `field.ref` at module scope (or on `f.<name>` inside a v1 steps
closure):

```ts
const worklog = p.string({ title: "Worklog" }).showWhen(severity.is("urgent"));
// in an effect's args:
const note = worklog.ref.orElse("");
// => '${{ parameters.worklog | default("") }}'
```

The default is JSON-encoded into the filter: a string is quoted and escaped, a number or
boolean is written bare (`orElse(0)` → `default(0)`, `orElse(false)` → `default(false)`).
Call `.orElse` on any conditional field to resolve its possible absence before it reaches an
effect input or `output`.

## Effects — `effect(...)` and the pack helper pattern

An **effect** wraps a side-effectful action step (a submit, a provision, a notification) and
returns a typed handle. `handle.output` is a reference rooted at
<code v-pre>${{ steps['&lt;id&gt;'].output }}</code>; navigating it (`ticket.output.body.url`)
renders the full path and carries the field's type, so a wrong-typed use squiggles. The
output shape is the handle's type parameter — a pack helper declares it once.

In practice a **pack** publishes a typed effect helper the same way it publishes typed field
helpers (`defineField`) and step helpers (`defineAction`). The helper is a
`defineAction`-style factory: it wraps `effect(...)`, pins the action id and the output
shape, and — like `defineAction`'s `simulate` — registers the action's `execute()` simulator
at import. This is `examples/oven-support-v2/plugin.ts`, trimmed:

```ts
import { type EffectHandle, type EffectInputValue, effect, registerActionSimulator } from "@tdk/core";

interface TicketOutput { body: { url: string; id: string } }

// The execute() simulator. The rendered `input` is Record<string, unknown>, so a value
// read from it is `unknown` — coerce it (String(input.oven)) before using it in a string.
function simulateRaiseTicket(input: Record<string, unknown>): TicketOutput {
  const id = `TCK-${String(input.oven)}`;
  return { body: { id, url: `https://catalog.example/tickets/${id}` } };
}
registerActionSimulator("bakery:raise-ticket", simulateRaiseTicket);

// EACH arg is EffectInputValue, NOT InputValue. EffectInputValue admits any InputValue
// AND a bare param const — so a consumer passes `site: bakeryCode` directly and the effect
// normalizes it to `.ref`. Typing an arg as plain InputValue would REJECT a bare const.
interface RaiseTicketArgs {
  title: EffectInputValue;
  summary: EffectInputValue;
  site: EffectInputValue;
  oven: EffectInputValue;
}

export function raiseTicket(id: string, args: RaiseTicketArgs): EffectHandle<TicketOutput> {
  return effect<TicketOutput>(id, "bakery:raise-ticket", { name: "Raise the ticket", input: { ...args } });
}
```

Two traps this pattern encodes:

1. **A helper arg is `EffectInputValue`, never `InputValue`.** `EffectInputValue` is
   `InputValue | ParamBase<unknown>` — it admits a bare param const; `InputValue` does not.
   PR #26's review caught a doc snippet that typed the arg loosely — the documented call then
   rejected itself.
2. **A simulator's `input` is `Record<string, unknown>`.** A value read from it is
   `unknown`, so <code v-pre>`TCK-${input.oven}`</code> is a type error — coerce with
   `String(input.oven)` (or a cast) first.

`opts` is `{ input?, name?, when?, if?, after? }`. Bare param consts in `input` normalize to
their `.ref` (like `derive`). `.when(pred)` / `when:` makes the effect conditional
(`notify.when(severity.is("urgent"))`), compiling to `if:` — see
[when](#when-conditional-effects-and-steps). `.after(otherEffect)` / `after:` states an
order-only edge between two effects with no data dependency (data dependencies order
themselves):

```ts
const notify = effect("notify", "svc:notify", { input: {} }).after(ticket); // runs after `ticket`
```

### `effects:` — the reachability roots

`effects` is the list of reachability roots. The compiler collects the steps — **every
effect, plus every `derive` transitively referenced by an effect's input, `if`, or the
`output`** — and orders them: **data-dependency first** (one effect reading another's output,
or an effect reading a derive), then **effects-list declaration order** for peers with no
data dependency, then any `after:` edge. The sharp edges match `derive`: a duplicate name
errors, a cycle errors, and a declared-but-unreachable derive warns (never dropped in
silence).

### `rawEffect(step)` — the escape hatch

Anything the `effect(...)` sugar can't express — a step from a v1-style `defineAction`
helper, a hand-built object, an unusual input shape — wraps as an effect with
`rawEffect(step)`. The step keeps its id/action/input/if verbatim; the type parameter types
its `.output`. It drops straight into the `effects:` list.

## Pages — the ordered table of contents

`pages` is an ordered array of `page(title, props, opts?)`. It is the form's table of
contents **and** the params' name-binding site: a param's name comes from its property key,
and names must be unique across all pages (the field namespace is flat — a duplicate throws).
Field order within a page is source order, so each page's **`ui:order` is inferred** and
emitted explicitly (so RJSF's field order is pinned to the authored TOC). Conditional
(`showWhen`) fields live in `dependencies`, not the base `properties`, so they are not listed
in `ui:order`.

```ts
pages: [
  page("Oven and site", { bakeryCode, ovenId, ovenType }),
  page("The problem", { severity, problemArea, otherDetail, urgentReason }),
  page("Contact", { contactEmail }),
],
```

The colocated `page(title, props, opts)` form takes only `{ uiOrder }` in `opts` — pass it
to override the inferred order. Everything else a page can carry — `required`,
`dependencies`, `rawDependencies`, `rawSchema` — lives on the **object form**
`page({ title, properties, … })`, because those settings sit beside the fields. `required`
otherwise derives from the properties' `required: true` flags.

### Reusable pages with `fragment`

`fragment(title, props)` builds a shareable colocated page, authored once and dropped into
many templates. A fragment is just a `page` value, so compose it into `pages:` like any page.
Concrete org-specific fragments are built on top of it and live in the consumer's own shared
code — core ships only the mechanism.

```ts
import { fragment, p } from "@tdk/core";
const teamPage = fragment("Team", { team: p.string({ title: "Team", required: true }) });
```

A common org rule is a **Baking Justification** page — a single-field page built with
`fragment()`, composed **last** and only when the requirements ask for one.

### `rawDependencies` and `rawSchema` — raw JSON-Schema escape hatches

When a page needs JSON-Schema that TDK does not model, the **object form**
`page({ title, properties, … })` takes two verbatim merge points:

- `rawDependencies` — merged into the page's compiled `dependencies` object.
- `rawSchema` — merged into the page object at the top level, for `if`/`then`/`else`,
  `anyOf`, `allOf`, and anything else that sits beside `properties`.

## Output — a plain map of handles

`output` is a plain object (not a function), because the fields are module-scope consts. It
reads effect and derive outputs **by handle** — `ticket.output.body.url`, a `derive` handle
directly — so no <code v-pre>${{ steps[...] }}</code> string is written by hand. `output` is
also a reachability root: a derive referenced only by `output` is still collected.

```ts
import type { InputValue } from "@tdk/core";

const outputMap: Record<string, InputValue> = {
  ticketUrl: ticket.output.body.url,   // effect sub-ref
  ticketId: ticket.output.body.id,
  sla: slaHours,                        // a derive handle reads as its result
};
```

When `output` holds heterogeneous lists (e.g. a `text: [...]` list where only some items
carry a `default`), annotate the value with `InputValue` types so TS checks element-wise
instead of inferring a too-narrow union — and do NOT flatten the lists into scalar keys to
dodge a type error:

```ts
const richOutput: Record<string, InputValue> = {
  text: [
    { title: "Summary", content: ticket.output.body.url },
    { title: "Status", content: ticket.output.body.id, default: true },
  ],
  links: [{ title: "My Orders", url: ticket.output.body.url }],
};
```

## Compile-time data with `load()`

`load` fetches external data at compile time (TDK's `generateStaticParams`), and the form
becomes a function of that typed data, so live values bake into it as real options.
`load({ env })` runs once per target environment (memoized). Because the form is the
name-binding site and must see the loaded options, a `load()` template pairs `load` with the
`parameters: (data) => [...]` shape:

```ts
import { defineTemplate, type LoadContext, p, page, step } from "@tdk/core";

export const OrderCake = defineTemplate({
  id: "order-cake", title: "Order Cake", type: "service",
  load: async ({ env }: LoadContext) => ({ flavors: await bakery.flavors(env) }),
  parameters: (data) => [                 // data: { flavors: string[] }
    page("Cake", { flavor: p.choice(data.flavors, { title: "Flavour", required: true }) }),
  ],
  steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
});
```

A `load()` template must compile via the async path (`compileResolved` / `compileAll` /
`execute`); the synchronous `compile()` throws. In tests, either inject data through a
fixture's `loaded: {…}` (which skips `load()` and stays deterministic) or fake the network
while the real `load()` runs.

### Loading real data

`load()` can do a real HTTP `fetch` — the stub above is only for brevity. The one rule for a
fetching loader: make the base URL injectable, so a test can point it at a local mock without
editing the template.

```ts
// The base URL — env var wins, else a default. Read it INSIDE load(), not at import,
// so a test can set it before the first fetch.
function menuApiBaseUrl(): string {
  return process.env.BAKERY_MENU_API ?? "https://menu.bakery.example";
}

export const load = async ({ env }: LoadContext) => {
  const response = await fetch(`${menuApiBaseUrl()}/api/${env}/flavours`);
  if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`);
  const { flavours } = (await response.json()) as { flavours: string[] };
  return { flavours };
};
```

`load({ env })` runs once per env, so the fetch path selects the env-specific catalog and
each target bakes its own options — the leak check still enforces that a prod-only value
never reaches the test artifact.

There are two ways to test a fetching loader, and they are complementary — see
[testing a real load()](/guide/testing#testing-a-real-load). `examples/api-loaded` is the
worked example: a `load()` that fetches over HTTP, tested both ways.

## Per-environment values — `env.pick({ … })`

A marker for any value that differs per environment. Compile resolves it to the target
environment's value (kept as its native type when used as a whole input value). Keys are your
environment names — `test` / `prod`, or `dev` / `staging` / whatever your org runs — plus an
optional reserved `default` fallback used when the target environment has no explicit entry.
Every pick is recorded so the environment safety check knows which values are exclusive to a
single environment.

```ts
const oven = env.pick({ test: "test-oven", prod: "prod-oven" });              // two envs
const cluster = env.pick({ dev: "dev-c", staging: "stg-c", prod: "prod-c" }); // three envs
const region = env.pick({ prod: "eu-west", default: "eu-central" });          // default fallback
```

Compiling for an environment the pick does not know (and with no `default`) throws, naming
the pick's known environments and the miss — for example `env.pick has no value for env
"staging" (knows: test, prod) — add a "staging" entry or a "default"`.

For the full environment model and the leak check, see
[Core concepts](/guide/concepts#the-environment-model).

## `raw` — raw Scaffolder expressions

A tagged template that interpolates param `.ref`s, `env.pick` markers and literals into one
verbatim Scaffolder expression string.

```ts
const message = raw`Baking ${cakeName.ref} (${bakeryCode.ref})`;
// -> "Baking ${{ parameters.cakeName }} (${{ parameters.bakeryCode }})"
```

`` raw.jsonata`...` `` (also exported as `` jsonata.raw`...` ``) is the escape hatch for
verbatim JSONata — see [Write expressions](/guide/expressions). Use `raw` for a **single**
static/interpolated string with no logic; anything with a guard, an intermediate value or
conditional assembly belongs in a `jsonata` block body or a derive.

## `require(cond, msg)` — the guard clause spelling

`require` is an alias of `assert`, read as a sentence: "require the manager to be resolved,
or fail with this message." Use it inside a `jsonata(...)` arrow (or a `derive` lambda) to
guard a precondition. It compiles to exactly the same JSONata `assert` does — see
[block-bodied arrows](/guide/expressions#block-bodied-arrows) for the full guide to
`jsonata(...)`.

```ts
jsonata<{ manager: string }>((c) => {
  require(c.manager !== "", "Your line manager could not be resolved.");
  return { ok: true };
});
```

`assert` stays exported and documented for authors who already know the JSONata `$assert`
name; new authoring should reach for `require`.

## Lifecycle gating

`lifecycle: { state, restrictedToUsers? }` drives `spec.restrictedToUsers`. A non-`"ga"` state
fails closed: it must carry a `restrictedToUsers` list — compile throws otherwise, because an
in-progress template must name who may see it while it is not generally available.

```ts
lifecycle: { state: "uat", restrictedToUsers: ["baker-042", "uat-stakeholder"] }
```

## `extraSpec` — custom spec fields

`extraSpec` merges arbitrary top-level keys into `spec` — the escape hatch for fields TDK does
not model.

```ts
extraSpec: {
  bakery_catalogue_metadata: { category_L1: "Signature Bakes" },
}
```

A key in `extraSpec` that collides with a field TDK already models under `spec` (for example
`steps` or `parameters`) throws at compile.

## Compile fails loudly

A whole class of authoring mistakes that used to ship silently now throw at compile — the
earliest, loudest place to catch them:

- a `pages`/`parameters` property whose value is not a `Param` (wrap it in a `p.*` helper)
- a field's `showWhen` and a controller's `dep.when` both targeting one controller
- a `showWhen` cycle, or a `showWhen` referencing a non-existent controller
- an `any(...)` OR spanning different fields in a `showWhen` (one dependency keys off one
  controller — use `.in([...])` for an OR on one field)
- a `showWhen` controller on a different page (each page is its own object schema)
- a derive dependency cycle, or two derives sharing a name
- a v2 config that also declares `steps:`/`parameters:` (the two shapes must not mix)
- an `env.pick` marker or a resolver marker surviving into a compiled artifact (a marker that
  was never resolved)
- an `extraSpec` key colliding with a field TDK already models under `spec`
- a non-`"ga"` `lifecycle` without `restrictedToUsers` (fails closed)
- a duplicate step id, a duplicate param name (across pages), or a `Param` rebound to a
  different name
- an `enumNames` whose length does not match its `enum`

A declared-but-unreachable derive does not throw — it is excluded from emission with a
warning on `CompileResult.diagnostics`. For why the compiler works this way, see
[Silent to loud](/guide/concepts#silent-to-loud-why-the-compiler-throws).

## Output shape

A compiled artifact is a Backstage Template entity:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: <id>
  title: <title>
  description: <description>
  tags: [...]
spec:
  type: <type>
  restrictedToUsers: [...]   # only while lifecycle.state !== 'ga'
  parameters: <an array of form pages, or a single JSON Schema form>
  steps: [ { id, name, action, input } ]   # derives + effects, planned in order
  output: {...}
  # ...plus any keys from `extraSpec`
```

## Compatibility: the v1 primitive layer

The v2 surface compiles **through** an older primitive layer that still exists and still
compiles, byte-for-byte unchanged. Reach for it only when v2 can't express a shape — a
scaffolding step with no data flow, an exotic dependency tree, a hand-built input, or a
`load()` form. It will be removed in a pre-1.0 breaking bump, so do not author new templates
on it wholesale.

### `defineTemplate({ parameters, steps, output })`

The v1 config takes the metadata plus `parameters` (the form), `steps` (a function of the
typed field-ref map `f`) and an optional `output` (same `f`):

```ts
import { defineTemplate, env, p, page, raw, step } from "@tdk/core";

export const OrderCake = defineTemplate({
  id: "order-cake", title: "Order Cake", type: "service",
  parameters: [
    page("Cake", {
      flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
      size: p.enum(["Small", "Large"], { title: "Size", required: true }),
    }),
    page("Extras", { notes: p.string({ title: "Notes", uiWidget: "textarea" }) }),
  ],
  steps: (f) => [
    step("place", "debug:log", {
      name: "Place order",
      input: {
        oven: env.pick({ test: "test-oven", prod: "prod-oven" }),
        message: raw`Baking ${f.flavor} (${f.size})`,
      },
    }),
  ],
  output: (f) => ({ flavour: f.flavor }),
});
```

`f.<name>` is the param's `.ref`, carrying the param's TS type. `parameters` is a flat props
object (one page) or an array of `page(...)`; with `load()` it is `(data) => form`.

### `step(id, action, opts?)`

Builds one `Step`. `opts` is `{ input?, name?, if?, when? }`:

- `input?: Record<string, InputValue>` — values may be `f.<param>` refs, `env.pick`,
  `raw`/`jsonata`/`nj` expressions, or literals.
- `name?: string` — the human-readable step name.
- `if?` — a templated run condition; accepts a `string | boolean | RawRef | jsonata`/`nj`
  expression `| Resolvable`.
- `when?` — the typed-predicate sugar for `if?` (see [when](#when-conditional-effects-and-steps)).

A v1 `steps:` list may mix manual `step(...)` calls with derive handles: a derive reachable
from a manual step's `output` is collected and planned between the step that produces its
inputs and the step that reads it.

### `dep.when(controller, branches)` — the JSON-Schema dependency builder

`dep.when` builds a JSON-Schema `dependencies` entry by hand, for branch shapes `showWhen`
can't express (one body for several controller values, `not`, chained reveals). It lives in
a page's `dependencies` array, so use the object form of `page(...)`:

```ts
const orderType = p.enum(["standard", "custom", "wedding"], { title: "Order type", required: true });

page({
  title: "Order Type",
  properties: { orderType },
  dependencies: [
    dep.when(orderType, [
      dep.eq("wedding", { properties: { tiers: p.number({ title: "Tiers" }) } }),
      dep.oneOf(["custom", "wedding"], { properties: { notes: p.string({ title: "Notes" }) } }),
    ]),
  ],
});
```

| Builder | Match emitted | Use |
| --- | --- | --- |
| `dep.eq(v, body?)` | `{ const: v }` | controller equals `v` |
| `dep.oneOf([...], body?)` | `{ enum: [...] }` | controller is one of |
| `dep.not(v, body?)` | `{ not: { const: v } }` | controller is anything but `v` |

`v` may be a string, number or boolean. `body` is `{ properties?, required?, dependencies? }`
— and because a branch can carry its own `dependencies`, conditionals nest. A `dep.when` and a
`showWhen` targeting the same controller collide and throw — pick one per controller.
