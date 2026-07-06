---
"@tdk/core": minor
---

snapshot-affecting: `execute()` now HALTS at the first failed step, mirroring real Backstage — a failed scaffolder task stops immediately, its later steps never run, and it produces no output. When a step ends with an `error` (a `roadiehq:utils:jsonata` expression that threw, e.g. an `$assert` guard, or an input that fails to render), that step keeps its `error` and rendered input exactly as before, but every step after it is now recorded as `{ notReached: true }` with no rendered input, and the template `output` is `undefined`. A new `notReached?: boolean` field on `ExecuteStepResult` marks these steps (distinct from `skipped`, a falsy `if:`, which does NOT halt — steps after a skip still run).

**Scenario snapshots re-render for any scenario that contains a failing step:** downstream steps become `notReached`, and the halted run's template `output` is omitted. Run `tdk test -u` to accept these changes — each such diff is fully explained by the new halt-at-first-error semantics. Happy-path scenarios (no failing step) are byte-identical and unaffected.
