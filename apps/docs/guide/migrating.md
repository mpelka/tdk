# Migrate a fleet of legacy forms

You have a fleet of forms in a legacy system, and you want them in TDK. This guide is
for the person who writes the parser that reads those forms. It explains the model
your parser produces, the command that turns each model into a template, and the four
checks that catch a conversion bug before it reaches a real Backstage.

Read the [migration model and printer decision](/guide/decisions/0026-migration-model-and-printer)
first if you want the reasoning. This guide is the how-to.

## The pipeline

A migration has two halves, on opposite sides of a confidentiality wall:

- your parser reads the proprietary exports. It lives in your private repo.
- the TDK printer emits TDK source. It lives in the public TDK repo.

The two halves never share code. They share a contract instead: a plain-JSON model
that crosses the wall as data.

```text
legacy export  →  YOUR parser  →  model.json  →  tdk migrate  →  template.ts + scenarios + report
   (private)       (private)      (the wall)      (public)          (you own it)
```

Your parser's job is format conversion. Everything hard — the typed shape, the
wiring, the ordering — the printer and the TDK compiler own. The printer emits into
TypeScript, so a conversion bug becomes a compile error in the generated file, not a
silent defect in a scaffolded template.

The model is generate-once. The printer produces the first version of each template,
and from then on your team owns the file. Regenerating over a hand-edited file is a
deliberate overwrite, never an automatic build step.

## The model in one example

Here is a complete model. It has 4 questions, one conditional field, one computed
value, one lookup, and one submit action. Every example in this guide validates
against the published schema.

```json
{
  "modelVersion": "1",
  "template": {
    "id": "request-oven-maintenance",
    "title": "Request oven maintenance",
    "description": "Raise a maintenance work order for a bakery oven.",
    "type": "service",
    "tags": ["bakery", "oven", "maintenance"],
    "owner": "team-bakery"
  },
  "questions": [
    {
      "name": "bakeryCode",
      "type": "choice",
      "title": "Bakery site",
      "options": { "BK1": "Riverside", "BK2": "Old Town", "BK3": "Harbourfront" },
      "required": true,
      "exampleValue": "BK1",
      "page": "Site"
    },
    { "name": "ovenId", "type": "string", "title": "Oven asset ID", "required": true, "exampleValue": "OV-4471", "page": "Site" },
    {
      "name": "faultType",
      "type": "choice",
      "title": "Fault type",
      "options": { "heating": "Heating", "door": "Door", "other": "Other" },
      "required": true,
      "exampleValue": "other",
      "page": "Fault"
    },
    {
      "name": "faultDetail",
      "type": "string",
      "title": "Describe the fault",
      "exampleValue": "Door seal warped",
      "page": "Fault",
      "visibleWhen": { "field": "faultType", "is": "other" }
    }
  ],
  "logic": [
    {
      "name": "job-summary",
      "op": "template",
      "template": "Oven {oven} at {site}",
      "bindings": {
        "oven": { "op": "fieldRef", "field": "ovenId" },
        "site": { "op": "fieldRef", "field": "bakeryCode" }
      }
    }
  ],
  "lookups": [
    {
      "name": "assignee",
      "kind": "roster",
      "source": "roster://maintenance-team?site={bakeryCode}",
      "params": { "site": { "op": "fieldRef", "field": "bakeryCode" } },
      "at": "oven-maintenance.export.json#/fields/assignee"
    }
  ],
  "effects": [
    {
      "name": "submit-request",
      "kind": "workOrder",
      "actionRef": "legacy:oven-booking:create-work-order",
      "inputs": {
        "title": { "ref": "job-summary" },
        "site": { "ref": "bakeryCode" },
        "assignee": { "ref": "assignee" }
      }
    }
  ],
  "outputs": {
    "workOrderId": { "effectRef": "submit-request", "path": ["body", "id"] }
  }
}
```

## The model reference

A model document holds a `modelVersion` (start at `"1"`), a `template` meta block, an
array of `questions`, and optional `logic`, `lookups`, `effects`, and `outputs`.

### Template meta

The `template` block carries the id, title, description, type, tags, and owner. Only
`id` and `title` are required; `type` defaults to `service`.

### Questions

A question is one form field. It has a `name`, a `type`, and a `page` tag. The printer
groups the page tags into the pages table of contents in first-appearance order. The
`exampleValue` feeds fixture generation, so a migrated template is born testable.

The `type` is one of `string`, `choice`, `boolean`, `number`, or `array`. A `choice`
carries an `options` map of value to label. Pass-through options — `format`,
`pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `uiWidget`, `uiOptions`,
`items`, `default`, `required` — are emitted verbatim onto the field builder.

```json
{
  "modelVersion": "1",
  "template": { "id": "field-types", "title": "Field types" },
  "questions": [
    { "name": "site", "type": "choice", "options": { "BK1": "Riverside" }, "required": true, "page": "P" },
    { "name": "email", "type": "string", "format": "email", "page": "P" },
    { "name": "count", "type": "number", "minimum": 1, "page": "P" },
    { "name": "rush", "type": "boolean", "page": "P" },
    { "name": "parts", "type": "array", "items": { "type": "string" }, "page": "P" }
  ]
}
```

### Visibility — a restricted vocabulary

A question's `visibleWhen` mirrors the authoring layer's `showWhen`. Three shapes are
modelled, and nothing else:

- `{ "field": "x", "is": "value" }` — show when field `x` equals a value.
- `{ "field": "x", "in": ["a", "b"] }` — show when field `x` is one of a set.
- `{ "all": [ … ] }` — show when every nested predicate holds (an AND-chain).

```json
{
  "modelVersion": "1",
  "template": { "id": "visibility", "title": "Visibility" },
  "questions": [
    { "name": "severity", "type": "choice", "options": { "low": "Low", "urgent": "Urgent" }, "required": true, "page": "P" },
    { "name": "area", "type": "choice", "options": { "heating": "Heating", "other": "Other" }, "required": true, "page": "P" },
    { "name": "note", "type": "string", "page": "P", "visibleWhen": { "all": [{ "field": "area", "is": "other" }, { "field": "severity", "in": ["urgent"] }] } }
  ]
}
```

A cross-field OR, or a computed condition, has no place in this vocabulary. It goes to
the flagged channel instead: model it as a verbatim expression (see the escape hatch
below), and the printer emits it flagged for a person to wire by hand. The model
inherits the schema layer's limits on purpose — the conditions the authoring layer
rejects, the model rejects too.

### Logic — computed values

A named logic node becomes a `derive` in the emitted source. The printer collects its
inputs by walking the expression. The op set is small and audited:

- `fieldRef` — read a question's value: `{ "op": "fieldRef", "field": "ovenId" }`.
- `literal` — a constant: `{ "op": "literal", "value": 4 }`.
- `logicRef` / `lookupRef` — read another logic node or a lookup by name.
- `concat` — join parts: `{ "op": "concat", "parts": [ … ] }`.
- `template` — interpolate `{name}` placeholders from a `bindings` map.
- `conditional` — an if/else chain of `cases` (each a `when` and a `then`) plus `else`.
- `listMap` — map an array `source` to a list, binding each item to `as`.

```json
{
  "modelVersion": "1",
  "template": { "id": "logic-ir", "title": "Logic IR" },
  "questions": [
    { "name": "severity", "type": "choice", "options": { "normal": "Normal", "urgent": "Urgent" }, "required": true, "page": "P" },
    { "name": "parts", "type": "array", "page": "P" }
  ],
  "logic": [
    {
      "name": "sla-hours",
      "op": "conditional",
      "cases": [{ "when": { "field": "severity", "is": "urgent" }, "then": { "op": "literal", "value": 4 } }],
      "else": { "op": "literal", "value": 24 }
    },
    {
      "name": "part-list",
      "op": "listMap",
      "source": { "op": "fieldRef", "field": "parts" },
      "as": "part",
      "body": { "op": "concat", "parts": [{ "op": "literal", "value": "OV-" }, { "op": "fieldRef", "field": "part" }] }
    }
  ]
}
```

### The escape hatch

For logic the IR cannot express, use a verbatim expression. Give it a name, a
language (`jsonata`, `nunjucks`, or `scaffolder`), and the source. The printer
preserves the source, flags it, and counts it in the report. Nothing is dropped.

```json
{
  "modelVersion": "1",
  "template": { "id": "escape-hatch", "title": "Escape hatch" },
  "questions": [{ "name": "parts", "type": "array", "page": "P" }],
  "logic": [
    { "name": "priority-code", "kind": "expression", "language": "jsonata", "source": "$count(parts) > 3 ? \"bulk\" : \"standard\"" }
  ]
}
```

### Lookups

A lookup is an opaque reference to an external source — a roster, a directory, a
service. The model preserves the reference; it does not interpret it. Every lookup is
flagged, whether or not you supply a resolver mapping, because its semantics stay
unresolved by design. Give it a `name`, a `kind`, the `source` string verbatim,
optional `params`, and an optional `at` source location for the report.

### Effects

An effect is a legacy submit action. Give it a `name` (the step id), a `kind`, the
`actionRef` verbatim, an `inputs` map, and an optional `when` condition. The printer
maps each effect through the action mapping you supply. An unmapped effect prints as a
direct `effect(...)` call with a flag, so the printer is usable with no mapping at all.

### Value references

A value in a mapping position — an effect input, a lookup param, an output — is one
of these:

- `{ "ref": "name" }` — resolve a name across questions, logic nodes, and lookups.
- `{ "questionRef": "name" }` / `{ "logicRef": "name" }` / `{ "lookupRef": "name" }` — assert the kind.
- `{ "effectRef": "name", "path": ["body", "id"] }` — read an effect output, with an optional sub-path.
- `{ "literal": 42 }` — a constant.
- an inline logic expression, for example `{ "op": "fieldRef", "field": "bakeryCode" }`.

## The action and lookup mapping

The mapping keeps the printer organisation-agnostic. You supply a small config that
maps each legacy action to a pack helper, and each lookup kind to a resolver marker.
The printer knows nothing about any one action; it looks each up here.

```json
{
  "actions": {
    "legacy:oven-booking:create-work-order": { "import": { "name": "createWorkOrder", "from": "./pack.ts" } }
  },
  "lookups": {
    "roster": { "import": { "name": "maintenanceRoster", "from": "./pack.ts" } }
  }
}
```

An action key is the effect's `actionRef` verbatim. A lookup key is the lookup's
`kind`. Pass the file with `--mapping`. Without it, every effect prints as a flagged
direct `effect(...)` and every lookup as a flagged placeholder — nothing breaks.

## Run the migration

The migration passes four gates, each catching its own class of bug. Run them in
order.

Gate 0 checks that the model validates against the schema and its semantic rules. This
is your parser's inner loop — run it before you print anything.

```sh
tdk migrate model.json --validate-only
```

An invalid model prints a path-qualified error and exits non-zero. Add `--json` for a
machine-readable report. A typo in a reference gets a suggestion, for example
`questions[3].visibleWhen.field: "sevrity" is not a declared question (did you mean "severity"?)`.

Print the templates once the model validates:

```sh
tdk migrate model.json --out ./templates --mapping mapping.json
```

The printer writes `./templates/<template-id>/` with `template.ts`, its
`__fixtures__/scenarios.ts`, and `migration-report.json`. It refuses to overwrite an
existing directory unless you pass `--force`. After printing, it runs the emitted
template through compile and validate as a smoke, and reports the result.

Gate 1 checks that the emitted code typechecks. A conversion bug — a condition that
references a dropped question, an input with the wrong shape — is a compile error in
the generated file.

```sh
bun run typecheck
```

Gate 2 runs the generated scenarios. The born-testable fixtures run through the
scenario engine and write the first snapshot baseline.

```sh
tdk test ./templates/request-oven-maintenance
```

The printer generates one happy-path scenario, filled from the `exampleValue`s, with
a `branches` list naming the conditional reveals it exercises and each effect output
mocked. This is a starting baseline you extend: add a scenario per branch you want to
pin. (ADR-0026 sketches one generated scenario per visibleWhen branch; the printer
currently emits the single baseline instead, pending an ADR amendment.)

Gate 3 confirms the rest against a real instance — the behaviour the earlier gates
cannot see.

```sh
tdk dry-run ./templates/request-oven-maintenance/template.ts
```

## The report

Every template gets a `migration-report.json`. It counts what translated and what was
flagged, and quotes every flagged construct with its model path. A reviewer reading
the generated file and a script reading the report both see the same honest account.

```json
{
  "template": "request-oven-maintenance",
  "modelVersion": "1",
  "counts": { "translated": 6, "flagged": 1 },
  "flagged": [
    {
      "construct": "lookup",
      "name": "assignee",
      "reason": "external reference, no interpretable semantics",
      "path": "lookups[0]",
      "at": "oven-maintenance.export.json#/fields/assignee",
      "verbatim": "roster://maintenance-team?site={bakeryCode}",
      "emittedAs": "maintenanceRoster({ site }) with a TODO"
    }
  ],
  "notes": []
}
```

## Nothing is dropped

One rule holds the design together: nothing is silently dropped. Every construct the
printer cannot map becomes a flagged `TODO(migration)` comment in the code, a report
entry, or both. A lookup keeps its source verbatim in a comment. An unmapped effect
keeps its action id. A verbatim expression keeps its full source. You always get an
honest account of what did not translate, so you can finish the wiring by hand.
