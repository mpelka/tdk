# 25. Authoring v2: the dataflow model

- Status: Proposed — the design later implementation phases build against. The naming
  pick in this record awaits the maintainer's ratification at review.
- Date: 2026-07-18

## Context

The authoring API works, but it still mirrors the wire format in three ways. A template
reads as an execution plan, not as intent, and the compiler is underused. This record
sets the design that the next phases build against.

### 1. Conditional fields are authored as the schema's tree shape

A conditional field today is a nested `dep.when` / `dep.eq` tree that carries
`properties` and `dependencies` blocks, plus the closed-world bookkeeping JSON Schema
needs — empty `dep.eq("No")` branches, `dep.not(...)` for the else side. The author
writes the schema's tree instead of the field's intent:

```ts
// v1 — the wire's tree shape, written by hand
dep.when("severity", {
  eq: "urgent",
  then: { urgentReason: p.string({ title: "Why is this urgent?" }) },
  else: {},                       // closed-world bookkeeping the author must not forget
});
```

The intent is one sentence — "show urgentReason when severity is urgent" — but the
author spells out the branch structure the compiler could synthesise.

### 2. Values are plumbed stringly

A value produced by one step and used by another travels as a hand-written
interpolation, repeated at every use, with a defensive filter for any field that might
be absent:

```ts
// v1 — the reference is a string, defended by hand
input: {
  title: raw("${{ steps['ticket-title'].output.result }}"),
  detail: nj("${{ parameters.otherDetail | default('') }}"),
}
```

Nothing type-checks the step name or the field name, and the `| default('')` is the
author remembering what the compiler could prove.

### 3. Computed-value steps state everything twice

A step that computes a value declares its inputs as a hand-written `Ctx` type and ships
the same fields again as a `data:` map, wrapped in id, name and action ceremony:

```ts
// v1 — the input shape is declared twice, once as a type, once as data
type SlaCtx = { severity: string };
step("sla-hours", "roadiehq:utils:jsonata", {
  input: {
    data: { severity: raw("${{ parameters.severity }}") } satisfies SlaCtx,
    expression: "severity = 'urgent' ? 4 : severity = 'normal' ? 24 : 72",
  },
});
```

The type and the `data:` map are the same fact written twice, and the whole step is
scaffolding around one lambda.

## Decision

Author templates as a dataflow graph of module-scope values that reference each other.
The compiler walks the graph, synthesises the schema tree, wires the references, and
orders the steps. The running example below is an oven-support request — a bakery asks
for help with an oven, and the template raises a ticket in the org's service catalog. It
has eight fields across three pages, two conditional fields, two computed values and one
submit action.

### 1. Fields are module-scope consts with their own visibility

Declare each field once, as a const, and give it its own visibility with
`.showWhen(predicate)`:

```ts
// Page 1 — oven and site
const bakeryCode = p.choice(
  { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
  { title: "Bakery site", required: true },
);
const ovenId = p.string({ title: "Oven asset ID", required: true });
const ovenType = p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true });

// Page 2 — the problem
const severity = p.choice(
  { low: "Low", normal: "Normal", urgent: "Urgent" },
  { title: "Severity", required: true },
);
const problemArea = p.choice(["heating", "conveyor", "controls", "other"], {
  title: "Problem area", required: true,
});
const otherDetail = p.string({ title: "Describe the problem" })
  .showWhen(problemArea.is("other"));
const urgentReason = p.string({ title: "Why is this urgent?" })
  .showWhen(severity.is("urgent"));

// Page 3 — contact
const contactEmail = p.string({ title: "Who should we update?", format: "email", required: true });
```

Predicates are per-field equality or membership — `field.is(v)`, `field.in([vs])` —
composed with `all(...)` for an AND-chain:

```ts
// show the field only when both hold
.showWhen(all(problemArea.is("other"), severity.in(["normal", "urgent"])))
```

The compiler synthesises the full `dependencies` and `oneOf` tree, including every
else-branch the wire format needs. An OR across two different fields cannot be expressed
in the wire format, so the compiler rejects it with a loud diagnostic. An OR on the same
field is `field.in([...])`, which the compiler does express.

### 2. derive(name, inputs, fn) declares a named computed value

Declare a runtime-computed value with `derive`. Its inputs are typed references —
fields, lookups, or other derives. The Ctx type is inferred from the inputs object, so
there is no separate type and no `data:` map. The lambda transpiles exactly as
`jsonata()` does today:

```ts
const ticketTitle = derive("ticket-title", { bakeryCode, ovenId, severity }, (i) =>
  `${i.severity === "urgent" ? "[URGENT] " : ""}Oven ${i.ovenId} at ${i.bakeryCode}`,
);

const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
```

Consuming a handle anywhere auto-wires the
<code v-pre>${{ steps['ticket-title'].output.result }}</code> reference; the author never
writes it. Step ordering is a topological sort of the
reference graph. The name is explicit and mandatory because step names are user-visible
in the Backstage run log — naming is intent, not ceremony.

Typing is conditionality-aware. A field with a `showWhen` types as `T | undefined` in a
derive's inputs, which forces the lambda to handle absence, and the compiler emits the
default-filter it can prove necessary:

```ts
// otherDetail is conditional, so i.otherDetail is `string | undefined`
const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? (i.otherDetail ?? "unspecified") : i.problemArea,
);
```

### 3. Effects are declared, and steps are collected

A side-effectful step is a pack action helper that returns a typed handle. Here the
consumer's service-catalog pack exposes `catalog.raiseTicket(...)`, which returns a
handle exposing `output.body`:

```ts
const ticket = catalog.raiseTicket("open-oven-ticket", {
  title: ticketTitle,
  slaHours,
  site: bakeryCode,
  oven: ovenId,
  ovenType,
  area: problemArea,
  detail: otherDetail.orElse(""),
  urgentReason: urgentReason.orElse(""),
  contact: contactEmail,
});
```

The template declares its effects. Step collection is reachability from the effects and
the output; ordering is data-dependency first, then effects-list declaration order for
peers with no data dependency. An `after:` hint covers order-without-data-dependency.

### 4. Pages remain an explicit ordered list

Pages stay a first-class, ordered list — a table of contents of field references. Field
order within a page is source order in the list, so `uiOrder` is inferred with no
strings. Page-level constructs such as titles, and org-rule fragments like a standalone
final page, stay first-class.

```ts
export default defineTemplate({
  id: "oven-support-request",
  title: "Request oven support",
  type: "service",
  pages: [
    page("Oven and site", [bakeryCode, ovenId, ovenType]),
    page("The problem", [severity, problemArea, otherDetail, urgentReason]),
    page("Contact", [contactEmail]),
  ],
  effects: [ticket],
  output: {
    ticketUrl: ticket.output.body.url,
    ticketId: ticket.output.body.id,
  },
});
```

### 5. Sugar over the primitives

- `p.choice({ value: label })` or `p.choice([values])` replaces the enum and enumNames
  pair.
- `.when(predicate)` on an effect or a lookup compiles to `if:` —
  `notify.when(severity.is("urgent"))` raises the notification only for urgent tickets.
- `require(cond, msg)` is an alias of assert, read as a sentence.
- `.orElse(default)` on an optional ref supplies the default the compiler would otherwise
  make you defend by hand.

### 6. No classes

Version 2 completes the functional turn that
[ADR 22](/guide/decisions/0022-functional-definetemplate-over-class) began. The graph is
module-scope values referencing each other. Templates must stay introspectable data,
because the compiler's reachability walk, `execute()`, and the codegen tooling all depend
on reading them as data. Fluent handles give the method-call ergonomics —
`ticket.output.body.url`, `field.showWhen(...)` — without inheritance. No class-based
authoring surface returns; the `Template` class stays the internal model it already is.

## The naming decision

The computed-value verb had two finalists: `derive` and `computed`. The same bakery
computed values, written each way:

```ts
// finalist A — derive
const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
```

```ts
// finalist B — computed
const slaHours = computed("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);
```

The pick is `derive`. The reasons:

- Read-aloud quality. "Derive the SLA hours from the severity" is a sentence; the verb
  names the operation. "Computed the SLA hours from the severity" is not — `computed` is a
  past participle standing in for a verb.
- It joins TDK's verb-per-level vocabulary. TDK already names each operation with a verb:
  transpile, compile, execute — see
  [ADR 2](/guide/decisions/0002-compile-verb-not-synth). `derive` is a verb and sits with
  them cleanly; `computed` is an adjective describing a value, which breaks the pattern.
- Zero collision with the reserved vocabulary. `derive` shares no stem with transpile,
  compile or execute. `computed` sits one step from compile — two c-words at the template
  layer — and invites the same misread the compile-not-synth decision worked to avoid.
- Ecosystem resonance both ways. Svelte's `$derived` and Vue's and MobX's `computed` are
  both established idioms for a value defined as a function of other values, so neither
  finalist is unfamiliar. That makes the tie-breakers above decisive rather than the
  ecosystem.

`computed` is recorded as the loser. It is arguably the more widely recognised term, but
it reads as a noun or adjective rather than a verb, it clashes tonally and visually with
compile, and it does not fit the verb-per-operation house style. The maintainer ratifies
this pick at review.

## Alternatives considered

- Naming the declared list `steps:`, for Backstage familiarity — rejected. It is false
  familiarity. In version 2 the declared list is not the steps list: the compiled YAML has
  more steps than the list names. The wire keeps the wire's vocabulary; the source keeps
  the source's.
- Flattening pages to a per-field `page: "..."` tag — rejected, at roughly 70/30. The
  pages list is the form's table of contents, a deliberate UX artefact visible in five
  lines. Ordering by source position across a long file is fragile, and page-level rules
  and fragments need a first-class home. Migration tooling may accept per-question page
  tags as input and emit the table-of-contents form.
- Returning to a class-based API — rejected. See Decision 6 and
  [ADR 22](/guide/decisions/0022-functional-definetemplate-over-class).
- An RFC process for this design — rejected. This is a single-maintainer 0.x project. The
  ADR written before implementation is the design review, without the process overhead.

## Sharp-edge semantics

- Duplicate derive names within one template: compile error.
- A derive shared across templates, imported from a shared module: each consuming template
  gets its own step instance; name uniqueness is per-template, not global.
- A declared-but-unreachable derive: excluded from emission, with a loud compile warning —
  silent-to-loud, never dropped in silence.
- Effect peers with no data dependency: ordered by effects-list order; `after:` states an
  explicit constraint.
- `showWhen` predicates are form-layer: a restricted vocabulary compiled to schema. Derive
  lambdas are run-layer: the full transpiler. The same field ref works in both, but the
  two layers do not mix.
- `output` may reference a derive that no effect references. It is still collected, because
  output is a reachability root.

## Consequences

- Additive first. The existing primitives — `step()`, `dep.*`, the explicit `steps:` list
  — remain the layer the sugar compiles through. The old surface is deleted later, in a
  pre-1.0 breaking bump.
- Every emission-changing slice carries the `output-changing:` changeset flag. Gold
  standards stay value-equivalent, so any byte drift is announced, never silent — see
  [ADR 5](/guide/decisions/0005-value-equivalence-not-byte-equality) and the
  [stability contract](/guide/stability).
- Fleet migration happens lockstep in a later phase: the examples, the authoring skill,
  the docs, the `tdk init` scaffold, and the consumer repos move together.

### Dependencies

- Requires threading expression-marker result types through the step-input layer — the
  `InputValue` erasure documented on issue #7.
- Relates to issue #8 (env typing), issue #9 (`env.pick` recursion) and issue #10 (the
  simulator registry).
- Enables the issue #13 migration printer to target version 2 nearly one-to-one.

### Phase plan

1. Enablers. Thread expression-marker result types through the step-input layer so a
   handle carries its value type end to end.
2. Sugar and synthesis. Add `p.choice`, `require`, `.when`, `.orElse`, and the
   `showWhen` predicate compiler that synthesises the `dependencies` and `oneOf` tree.
3. The derive, effects and pages surface. Add `derive`, the effects list with reachability
   collection and topological ordering, and the field-reference pages list.
4. Fleet migration. Move the examples, the skill, the docs, `tdk init` and the consumer
   repos to version 2 in lockstep.
5. Close-out. Delete the residual v1 surface in a pre-1.0 breaking bump, and record the
   removal as its own ADR.
