---
"@tdk/core": minor
---

Thread expression-marker result types through the step-input layer (authoring-v2 phase 1, #15). Two new type-only exports:

- `TypedInputValue<V>` — the result-type-constraining sibling of the loose `InputValue`: the set of values that render to a `V`. A marker whose result type is wrong for its slot is now a compile error — a `jsonata(...)`/`nj(...)` rendering a number, a `Ref<number>`, or an `env.pick<number>` is rejected in a `TypedInputValue<string>` position and accepted in a `TypedInputValue<number>` one. It recurses through arrays and nested objects, so it composes over a JSON-Schema-shaped `V` (the building block for contract-typed step inputs). `RawExpr` and `Resolvable` stay untyped escape hatches, admitted in any typed slot.
- `MarkerValue<M>` — the extraction dual: the value type a marker carries (`MarkerValue<Ref<T>>` is `T`). This is what `derive` reads to infer its lambda context from its `inputs` object, with no hand-written `Ctx` type.

One supporting tightening: `Ref<T>`'s phantom (`__tdkRefType`) is now REQUIRED. Optional, the bare `ParamRef` base — the public `.ref` getter's return type — structurally satisfied `Ref<V>` for every `V`, a back door that would have erased the very result types `TypedInputValue` constrains. `Ref` values are only ever produced by `defineTemplate`'s field-ref map (cast-constructed), so construction and every existing consumer are unaffected; the whole workspace typechecks unchanged.

Types-only otherwise: nothing here runs, no runtime signatures change, and the loose `InputValue` keeps admitting everything it does today at every position that uses it — so no compiled YAML and no scenario snapshot changes. No `output-changing:`/`snapshot-affecting:` flag applies. Phase 2/3 wire these types into `derive` and the contract-checked step input; this slice only makes them expressible.
