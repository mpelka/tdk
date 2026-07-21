# 26. The migration model and printer

- Status: Proposed — the spec for [issue #13](https://github.com/mpelka/tdk/issues/13).
- Date: 2026-07-18

## Context

Organisations adopting TDK often migrate a whole fleet of forms from a legacy system.
That system exports its forms declaratively — questions, sections, conditional
visibility, submit actions, and references to backend services. A migration reads those
exports and writes TDK source.

The migration must respect a confidentiality wall. Two halves sit on opposite sides:

- the parser reads the proprietary exports. It lives in the organisation's private repo.
- the printer emits TDK source. It lives here, in the public repo.

[ADR 13](/guide/decisions/0013-push-safety-synthetic-theme) draws that wall: no real
template, not even a scrubbed one, enters this repo. So the two halves cannot share code.
They share a contract instead — a declarative model that crosses the wall as plain data.

The design principle is self-checking codegen. The printer emits into a typed language,
so a conversion bug becomes a compile error in the generated file, not a silent defect in
a scaffolded template. That is the first rung of a four-rung testing ladder: the generated
file typechecks, its generated scenarios execute, the organisation's contracts hold, and a
dry-run against a real instance confirms the rest. Each rung catches its own class of bug.
This extends [ADR 6](/guide/decisions/0006-fail-at-compile-or-test-not-scaffold-time): the
migration fails at compile or test time, never at scaffold time.

## Decision

Split the migration along the wall. The parser produces a versioned JSON model; the
printer consumes it and emits idiomatic v2 source. The model is the contract between them.

### 1 — the model

The contract is a versioned, plain-JSON document with a published JSON Schema. JSON,
because the producer side must be language-agnostic, trivially diffable, and
schema-validatable. The schema is the producer's first feedback gate: an export that does
not validate is rejected before the printer runs. The model version is independent of the
TDK package version, because the model is a public contract in its own right.

A document holds these node kinds:

- template meta — the id, title, description, tags, and owner.
- questions — a name, a type (string, choice, boolean, and so on), a title and
  description, an options map (value to label) for choices, a required flag, a default,
  and an exampleValue. The exampleValue feeds fixture generation, so a migrated template is
  born testable. Each question also carries a page tag: the page it belongs to. Producers
  hold this naturally, and the printer groups the tags into the pages table-of-contents
  form that [ADR 25](/guide/decisions/0025-authoring-v2-dataflow-model) settled on. (ADR 25
  rejected per-field page tags for authoring by hand, but noted migration tooling may
  accept them as input and emit the table-of-contents form.)
- visibleWhen — a restricted predicate vocabulary that mirrors the authoring layer's
  showWhen: `{field, is}`, `{field, in: [...]}`, and `{all: [...]}` for an AND-chain.
  Nothing outside this vocabulary is modelled. A cross-field OR, or a computed condition,
  goes to the flagged channel instead. The model inherits the schema layer's expressiveness
  limits on purpose — the same rejections, the same diagnostics philosophy.
- logic IR — a small op set for computed values: `fieldRef`, `literal`, `concat` and
  `template`, `conditional` (if/else chains), and `listMap`. The set is deliberately
  minimal, audited against real corpuses, and grows only by versioning the schema. Each
  logic node has a name, which becomes a `derive` in the emitted source.
- lookup nodes — an opaque, preserved reference to an external source: a kind, the source
  string verbatim, and its params. The printer emits a flagged TODO stub wired to the
  organisation's resolver conventions. The semantics stay deliberately unresolved: the
  model preserves the reference, it does not interpret it.
- effects — a legacy submit-action, modelled as a kind, the actionRef verbatim, and an
  inputs mapping (references to questions, logic nodes, or literals). The printer maps each
  effect through a configurable action mapping the organisation supplies (see Decision 2).
- the escape hatch — for logic the IR cannot express: `{kind: expression, language,
  source}`. The printer emits it as a clearly flagged block, counts it in the report, and
  never drops it in silence.

### 2 — the printer

The printer turns a validated model into an idiomatic v2 template.ts. The flagship
oven-support-v2 example — the running example of
[ADR 25](/guide/decisions/0025-authoring-v2-dataflow-model) — is the canonical output
shape: module-scope field consts with `.showWhen`, `p.choice` for options maps, a `derive`
per logic node, and effects through pack helpers. The printer emits the code a human would
keep and own, not machine soup.

The action mapping keeps the printer organisation-agnostic. The organisation supplies a
small config — each legacy action kind maps to a helper import and a call shape:

```ts
// org-supplied, on the private side of the wall
const actionMap = {
  "legacy:oven-booking:create-work-order": {
    import: { name: "createWorkOrder", from: "./pack.ts" },
  },
};
```

The printer knows nothing about any one legacy action; it looks each one up in the config.
The same holds for lookups: the organisation's resolver convention maps a lookup kind to a
marker. This follows [ADR 9](/guide/decisions/0009-core-org-agnostic-extension-hooks) — the
org-specific knowledge lives in the org's config, not in the shared printer.

Alongside the template, the printer emits:

- `__fixtures__/scenarios.ts`, generated from the questions' exampleValues, with one
  scenario per visibleWhen branch. The template is born testable, and its fixtures feed the
  scenario snapshots that
  [ADR 8](/guide/decisions/0008-scenario-snapshots-regression-baseline) makes the
  regression baseline.
- a machine-readable migration report per template: the translated and flagged counts, and
  every flagged construct quoted with its source location.

One invariant holds the design together: nothing is silently dropped. Every construct the
printer cannot map becomes a flagged TODO in the code, a report entry, or — usually — both.
A reviewer reading the generated file, and a script reading the report, both see the same
honest account of what did not translate.

### 3 — gates and phasing

The migration passes through four gates, each catching its own class of bug:

- gate 0 — the model validates against the published schema. The producer's first feedback,
  before the printer runs.
- gate 1 — the emitted code typechecks. A conversion bug, such as a condition referencing a
  dropped question, is a compile error in the generated file.
- gate 2 — the generated scenarios execute. The born-testable fixtures run through
  `execute()` and confirm the template behaves.
- gate 3 — a dry-run against a real instance confirms the rest, the behaviour the earlier
  gates cannot see.

Implementation comes in three phases, and only after the fleet-migration phase of
[ADR 25](/guide/decisions/0025-authoring-v2-dataflow-model) settles the v2 idiom the printer
targets:

1. The model: the JSON Schema and a validator library.
2. The printer: model to template.ts, scenarios, and report.
3. A CLI verb that runs the printer.

The printer is a migration tool, not a build step. The model is
generate-once-then-humans-own-it: the printer produces the first version, and from then on
people own the file. Regenerating over hand-edited source is an explicit, deliberate
overwrite, never an automatic build output.

## A worked example

A hand-written illustration. The legacy oven-booking system exports its "request oven
maintenance" form. The parser converts that export into the model below — four questions,
one visibleWhen, one logic node, one lookup, and one effect.

```json
{
  "model": "tdk.migration/v1",
  "template": {
    "id": "request-oven-maintenance",
    "title": "Request oven maintenance",
    "description": "Raise a maintenance work order for a bakery oven.",
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
    {
      "name": "ovenId",
      "type": "string",
      "title": "Oven asset ID",
      "required": true,
      "exampleValue": "OV-4471",
      "page": "Site"
    },
    {
      "name": "faultType",
      "type": "choice",
      "title": "Fault type",
      "options": { "heating": "Heating", "door": "Door", "controls": "Controls", "other": "Other" },
      "required": true,
      "exampleValue": "other",
      "page": "Fault"
    },
    {
      "name": "faultDetail",
      "type": "string",
      "title": "Describe the fault",
      "required": false,
      "exampleValue": "Door seal warped, heat escaping",
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
        "oven": { "ref": "ovenId" },
        "fault": { "ref": "faultType" },
        "detail": { "ref": "faultDetail" },
        "assignee": { "ref": "assignee" }
      }
    }
  ]
}
```

The printer emits this template.ts. The lookup has no interpretable semantics, so it is
flagged, not dropped:

```ts
import { defineTemplate, derive, p, page } from "@tdk/core";
// Action mapping (org-supplied): legacy:oven-booking:create-work-order -> createWorkOrder.
// Resolver convention (org-supplied): roster lookups -> the maintenanceRoster marker.
import { createWorkOrder, maintenanceRoster } from "./pack.ts";

// --- Fields (one const per question; page tags become the pages TOC below) ------
export const bakeryCode = p.choice(
  { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
  { title: "Bakery site", required: true },
);
export const ovenId = p.string({ title: "Oven asset ID", required: true });

export const faultType = p.choice(
  { heating: "Heating", door: "Door", controls: "Controls", other: "Other" },
  { title: "Fault type", required: true },
);
// visibleWhen { field: faultType, is: other } -> .showWhen(faultType.is("other"))
export const faultDetail = p
  .string({ title: "Describe the fault" })
  .showWhen(faultType.is("other"));

// --- Logic node 'job-summary' -> a derive ---------------------------------------
export const jobSummary = derive("job-summary", { ovenId, bakeryCode }, (i) =>
  `Oven ${i.ovenId} at ${i.bakeryCode}`,
);

// --- Lookup 'assignee' — FLAGGED, see migration-report.json ----------------------
// TODO(migration): external reference preserved verbatim from the legacy export.
//   source: roster://maintenance-team?site={bakeryCode}
// Emitted against the org's resolver convention. VERIFY the resolver exists and
// returns the expected shape before you rely on it.
const assignee = maintenanceRoster({ site: bakeryCode });

// --- Effect 'submit-request' via the mapped pack helper --------------------------
export const workOrder = createWorkOrder("submit-request", {
  title: jobSummary,
  site: bakeryCode,
  oven: ovenId,
  fault: faultType,
  detail: faultDetail.ref.orElse(""),
  assignee,
});

export default defineTemplate({
  id: "request-oven-maintenance",
  title: "Request oven maintenance",
  description: "Raise a maintenance work order for a bakery oven.",
  type: "service",
  tags: ["bakery", "oven", "maintenance"],
  owner: "team-bakery",
  pages: [
    page("Site", { bakeryCode, ovenId }),
    page("Fault", { faultType, faultDetail }),
  ],
  effects: [workOrder],
  output: {
    workOrderId: workOrder.output.body.id,
  },
});
```

It also emits scenarios from the exampleValues — one per visibleWhen branch, so the
conditional field is exercised the moment the template is generated:

```ts
import type { ExecuteFixture } from "@tdk/core";

// GENERATED from the model's exampleValues.
export const scenarios = [
  {
    name: "example — faultType 'other' (faultDetail visible)",
    branches: ["other"],
    fixture: {
      parameters: {
        bakeryCode: "BK1",
        ovenId: "OV-4471",
        faultType: "other",
        faultDetail: "Door seal warped, heat escaping",
      },
    } satisfies ExecuteFixture,
  },
];
```

And it writes the migration report. The lookup is flagged in both the code and the report —
the honest-fallback invariant in miniature:

```json
{
  "template": "request-oven-maintenance",
  "model": "tdk.migration/v1",
  "counts": { "translated": 6, "flagged": 1 },
  "flagged": [
    {
      "construct": "lookup",
      "name": "assignee",
      "reason": "external reference, no interpretable semantics",
      "at": "oven-maintenance.export.json#/fields/assignee",
      "verbatim": "roster://maintenance-team?site={bakeryCode}",
      "emittedAs": "maintenanceRoster({ site: bakeryCode }) with a TODO"
    }
  ]
}
```

## Alternatives considered

- Emitting the v1 authoring API — rejected. Version 2 is the idiom a migration should land
  on. Version 1 is the compatibility layer, not the target.
- Emitting Backstage YAML directly — rejected. It loses the tier-0 self-checking that is the
  whole payoff. Emitting YAML is what an ad-hoc migration does today, and its bugs surface
  only at scaffold time.
- A TypeScript API as the model, with builder objects instead of JSON — rejected. The
  producer side must be language-agnostic, trivially diffable, and schema-validatable. JSON
  is the format that crosses the confidentiality wall; a TypeScript API does not.
- Modelling arbitrary expressions in the IR — rejected. A Turing-complete IR recreates the
  unanalysable-monster problem the migration is trying to escape. The small op set, plus the
  escape hatch and the flagged channel, handle the long tail honestly.

## Consequences

- This ADR is the spec for [issue #13](https://github.com/mpelka/tdk/issues/13). The issue
  stays open for implementation and is updated after this record merges.
- The parser's job collapses to format conversion behind four machine-checkable gates.
  Everything hard — the typed shape, the wiring, the ordering — the printer and the compiler
  own.
- The model's visibleWhen mirrors showWhen, so migrations inherit the schema layer's
  expressiveness limits on purpose. The conditions the authoring layer rejects, the model
  rejects too, with the same diagnostics.
- Fixture generation makes every migrated template born testable, so a fleet migration
  arrives with its regression baseline already written.
- The model schema is versioned independently of the TDK packages, because it is a public
  contract the private parser depends on.

## Amendments

- 2026-07-20 — the template meta node gained an optional `extraSpec`: a free-form JSON
  object of custom top-level `spec` keys the DSL does not model, emitted verbatim as
  `defineTemplate`'s `extraSpec` and merged into the compiled entity's `spec`. A real
  migration from a legacy catalog system carried service-catalog metadata on every form
  (a category, a cost centre, an on-call routing block) that had no first-class field, so
  the model dropped it. `extraSpec` is the escape hatch that preserves it. It is
  deliberately exempt from the strict name/id character rules (it is free-form by design)
  but stays emission-safe: the printer renders it through the faithful `lit()` encoding
  the other safe positions use, so hostile characters round-trip into the compiled spec
  rather than injecting code. A model-only, additive change (`modelVersion` stays `"1"`).
- 2026-07-21 — the question node gained a `customField` type plus two members, `uiField`
  and `customType`: the escape hatch for Backstage custom field extensions (RJSF
  `ui:field`). A real migration hit legacy forms built on bespoke pickers — object-valued
  fields no first-class `p.*` builder models — so the printer now emits core's existing
  `p.customField`. `uiField` is legal on any question type (mirroring core, where every
  param accepts it); the pairings the schema cannot express are semantic-check errors: a
  `customField` requires its `uiField`, `customType` (the value's JSON-Schema `type`,
  e.g. `object`) belongs only to a `customField`, and `options` belongs only to a
  `choice` (previously a silent printer drop). Both new members are exempt from the
  strict name/id character rules like `uiWidget`/`uiOptions`, and stay emission-safe
  through the same `lit()` path, pinned by injection probes. A model-only, additive
  change (`modelVersion` stays `"1"`).
