---
"@tdk/core": minor
---

The migration model carries `extraSpec` — custom top-level template `spec` the DSL does not model (ADR-0026 amendment).

- The `template` meta node gains an optional `extraSpec`: a free-form JSON object of custom top-level `spec` keys. The printer emits it verbatim as `defineTemplate`'s `extraSpec`, which merges into the compiled entity's `spec` unchanged. Fills a real migration gap — a consumer moving off a legacy catalog system carried service-catalog metadata (a category, a cost centre, an on-call routing block) on every form that had no first-class field, so the model dropped it; `extraSpec` preserves it.
- It is the deliberate escape hatch, so its schema is free-form (`{ "type": "object" }`, additionalProperties allowed) — exempt from the strict name/id character rules the rest of the model enforces. It stays emission-safe: the printer renders it through the same faithful `lit()` encoding the other safe positions use, so a backtick, a `${`, a newline, or a quote in a value round-trips into the compiled spec rather than injecting code. Beyond "is an object" it is otherwise uninterpreted and unvalidated.
- Additive and model-only: `modelVersion` stays `"1"`, and a model without `extraSpec` prints byte-identically to before. Threaded through `model.schema.json`, the `TemplateMeta` type (new exported `JsonObject`), the printer, and the producer guide; pinned by a hostile-value round-trip test (parse + faithful spec round-trip via `compileResolved`).
