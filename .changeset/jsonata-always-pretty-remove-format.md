---
"@tdk/core": major
"@tdk/cli": major
---

Emitted JSONata is now always pretty-printed. `JsonataExpr.jsonata` returns the formatted (multi-line, statement-per-line) form and `.compact` remains the canonical single-line form, but the `Target.format` field (`"pretty" | "compact"`, previously threaded through `RefResolver` into `JsonataExpr.render()`) is removed, along with the `--compact` flag on `tdk compile`/`tdk build`. YAML now renders multi-line expressions as block scalars.

**Breaking.** `Target.format` no longer exists on the `Target` type — remove it from any target config. `--compact` no longer exists as a CLI flag — remove it from any script or CI invocation; compiled expression strings in generated YAML will be reformatted as pretty/multi-line (values are unchanged, only the emitted expression text changes, so `execute()` results and gold-standard scenario outcomes are unaffected, but any test asserting on the literal compiled YAML/expression string will need its fixture regenerated).

Bump level: pre-1.0 convention would allow a minor; `major` is used here because it removes a public `Target` field and a CLI flag outright, not just an additive change.
