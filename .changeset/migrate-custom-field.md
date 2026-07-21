---
"@tdk/core": minor
---

The migration model reaches `p.customField` — custom field extensions (`ui:field`) the DSL had no first-class question type for (ADR-0026).

- A question `type` gains `customField`, plus two members: `uiField` (the Backstage custom field extension name, emitted as `ui:field`) and `customType` (the JSON-Schema `type` of the field's value, e.g. `object`, mapped to `p.customField`'s `type`; core defaults it to `string`, so the printer emits it only when set). `uiField` is legal on ANY question type, mirroring core, where `uiField` is a `BaseParamOptions` member every param accepts. The printer emits an explicit `p.customField({ … })`, so a `.showWhen(…)` chain still types.
- New semantic checks in the established path-quality style: a `customField` requires `uiField`; `customType` on a non-`customField` is an error; and `options` (a `choice`-only construct) on a non-`choice` is an error rather than a silent drop.
- `uiField` and `customType` are exempt from the strict name/id character rules — like `uiWidget` / `uiOptions`, they emit through the injection-safe `lit()` path — yet stay emission-safe: hostile characters (backticks, `${`, newlines) round-trip faithfully into the compiled template rather than injecting code. Pinned by injection probes over `uiField`, `customType`, and an object `exampleValue`.
- Additive and byte-stable: `modelVersion` stays `"1"`, and a model that uses none of the new fields prints byte-identically to before. Threaded through `model.schema.json`, the `Question` type, the validator, the printer, the golden corpus, and the producer guide.
