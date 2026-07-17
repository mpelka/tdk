---
"@tdk/core": minor
---

Thread expression-marker result types through the step-input layer (authoring-v2 phase 1, #15). Two new type-only exports:

- `TypedInputValue<V>` — the result-type-constraining sibling of the loose `InputValue`: the set of values that render to a `V`. A marker whose result type is wrong for its slot is now a compile error — a `jsonata(...)`/`nj(...)` rendering a number, a `Ref<number>`, or an `env.pick<number>` is rejected in a `TypedInputValue<string>` position and accepted in a `TypedInputValue<number>` one. It recurses through arrays and nested objects, so it composes over a JSON-Schema-shaped `V` (the building block for contract-typed step inputs). `RawExpr` and `Resolvable` stay untyped escape hatches, admitted in any typed slot.
- `MarkerValue<M>` — the extraction dual: the value type a marker carries (`MarkerValue<Ref<T>>` is `T`). This is what `derive` reads to infer its lambda context from its `inputs` object, with no hand-written `Ctx` type.

Types-only and purely additive: nothing here runs, no signatures change, and the loose `InputValue` keeps admitting everything it does today at every position that uses it — so no compiled YAML and no scenario snapshot changes. No `output-changing:`/`snapshot-affecting:` flag applies. Phase 2/3 wire these types into `derive` and the contract-checked step input; this slice only makes them expressible.
