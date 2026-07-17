---
"@tdk/core": minor
---

Add the composed `showWhen` authoring surface (authoring-v2 phase 2, #17): a field declares its own visibility with predicates the compiler synthesises into the `dependencies`/`oneOf` tree, so the author writes intent instead of the schema's tree shape.

- `.showWhen(predicate)` — a fluent method twin of the `showWhen:` option, the ADR-0025 Decision 1 surface (`const detail = p.string({...}).showWhen(area.is("other"))`). Setting a field's visibility twice (option and method) throws.
- `any(...conditions)` — OR-composition on ONE field: `any(size.is("M"), size.is("L"))` is `size.in(["M", "L"])`, read as a disjunction. An OR across different fields cannot be expressed as a JSON-Schema dependency (one node keys off one controller), so it is rejected at compile with a loud diagnostic naming the fields and pointing at `.in([...])`.
- `Param.in([values])` — the array spelling from the ADR, beside the existing variadic `in(...values)`; both compile identically.

A `showWhen` controller declared on a different page is rejected with a pointed diagnostic — each wizard page is its own object schema, so a cross-page dependency has no wire form.

Emission-stable vs the previous release: the record form, the single-level `showWhen:` option, and hand-written `dep.*` compile to byte-identical YAML — the synthesiser only activates for the composed forms, and `dep.*` remains the exported low-level layer. One narrow surface change: the public `showWhen` property on `Param` became private (replaced by the same-named `.showWhen(...)` method and the existing `showWhen:` option); no known consumer read it. No `output-changing:`/`snapshot-affecting:` flag applies.
