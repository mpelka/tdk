---
"@tdk/cli": minor
---

Add `tdk execute --fixture-stdin`: reads a single fixture as JSON from stdin and runs just that fixture (instead of the sibling `scenarios.ts`), reporting `{ ok, result }` or `{ ok, error }`. Mutually exclusive with `--stdin`. Scenario reports from `tdk execute` also now additively include each scenario's `parameters`, `hasStepMocks`, and (when present) its `steps` mocks, alongside the existing `name`/`result`/`error` fields.

Purely additive — existing consumers reading only `name`/`result`/`error` are unaffected.
