---
"@tdk/core": minor
---

Params gain `errorMessage` — human validation messages emitted as the ajv-errors `errorMessage` keyword in the compiled schema. A string covers every keyword failure of the field, `required` included; the object form is keyword-keyed (`{ pattern: "…", required: "…" }`). `required` messages are lifted to the enclosing object schema (the page, the flat form, or the `showWhen`/`dep.when` branch that reveals the field) following the FINAL required list, page-level `required` overrides included. Rendered by the form preview and by Backstage's own RJSF (which registers ajv-errors); Backstage's backend validator (`jsonschema`) ignores the keyword, so artifacts stay compatible everywhere. Templates that don't use the option compile byte-identically.
