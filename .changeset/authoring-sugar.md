---
"@tdk/core": minor
---

Add the authoring-v2 sugar tier (ADR-0025 §5, phase 2, #16): `p.choice`, `.when()`, `require`, and `.orElse()`.

- `p.choice(values[], opts?)` / `p.choice({ value: label, … }, opts?)` — sugar over the `enum`/`enumNames` pair. Both forms route through the exact same `StringParam` construction a hand-written `p.string({ enum, enumNames })` call would produce, so the compiled schema is byte-identical to it. The value union is typed (the array's elements, or the object's keys), so `.is()`/`.in()` and scenario fixtures literal-check against it exactly like `p.enum` does.
- `.when(predicate)` — a new `when` option on `step(...)`, sugar for `if:`. Accepts the same typed predicates `showWhen` does (`field.is(v)`, `field.in(...)`, `all(...)`) and compiles them to the Nunjucks boolean `${{ … }}` string `if:` needs (`.is` → `==`, `.in` → the Nunjucks `in` operator, `all` → `and`). Supplying both `if` and `when` throws.
- `require(cond, msg)` — an alias of `assert` in the `jsonata(...)` expression layer, read as a sentence ("require the manager to be resolved, or fail"). Transpiles byte-identically to `assert` (same JSONata target function, same arity) and delegates to it at runtime. `assert` stays exported/documented; `require` is the preferred v2 spelling.
- `.orElse(default)` on a param ref — sugar for the Nunjucks `default` filter: `f.worklog.orElse("")` emits `${{ parameters.worklog | default("") }}`. The default is JSON-encoded into the filter (a string quotes/escapes, a number/boolean stays bare). Returns a `NunjucksExpr`, which composes with `TypedInputValue<T>` (issue #15/#21) like any other typed marker; on `Ref<T | undefined>` the result resolves to the non-`undefined` `T`.

Additive only: every form is new surface layered on the existing primitives (`p.string`, `step()`'s `if`, `assert`, param refs). No existing template's compiled YAML or `execute()`/scenario-snapshot output changes — the gold standards and snapshots gate this, unchanged.
