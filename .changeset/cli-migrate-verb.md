---
"@tdk/cli": minor
---

Add the `tdk migrate <models...>` verb (ADR-0026, #13): turn migration models into template directories.

- `--validate-only` runs gate 0 alone (schema + semantic validation), a path-qualified error to stderr and a non-zero exit on any invalid model; `--json` for a machine-readable report.
- A full run validates, prints each model into `<out>/<template-id>/` (`template.ts`, `__fixtures__/scenarios.ts`, `migration-report.json`), refuses to overwrite an existing directory unless `--force`, and prints a per-template summary of translated/flagged counts.
- `--mapping <file>` supplies the org's action/lookup mapping (a `.json` file, or a `.ts`/`.js` module with a default export).
- After printing, the CLI runs each emitted template through compile + validate as a smoke (gate-1-lite) and reports it. Exits non-zero if any model is invalid or any emission fails.
