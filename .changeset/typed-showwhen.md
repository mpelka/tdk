---
"@tdk/core": minor
---

Add a typed, ref-based `showWhen` form the editor can literal-check, alongside the existing record form: `Param<V>.is(value)` (one condition, checked against the param's own type), `Param<V>.in(...values)` (the OR form), and `all(...conditions)` (AND-composition). `showWhen` accepts the record form (unchanged), a single condition, or `all(...)`. Hoisting a page's controllers to consts turns a previously-stringly-typed reference into one TypeScript checks — a typo like `orderType.is("weding")` is now a compile-time error in the editor instead of a runtime compile error with no squiggle.

Purely additive — the existing record form (`showWhen: { orderType: "wedding" }`) is unchanged and compiles to byte-identical YAML.
