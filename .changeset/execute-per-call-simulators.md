---
"@tdk/core": minor
---

`execute()`'s `ExecuteOptions` gains `simulators?: Record<string, ActionSimulator>` — action simulators scoped to that one call. A per-call simulator takes precedence over the process-global `registerActionSimulator` registry for the same action id (still beaten by an explicit `fixture.steps[id]` mock, mirroring the existing mock-wins precedence). This decouples templates that happen to share an action id: a pack action helper can now ship a `simulate` for good `execute()` ergonomics without risking another template's snapshot baseline, by supplying it per call instead of registering it globally.

No `snapshot-affecting:` flag: this is purely additive to `ExecuteOptions`. An `execute()` call that passes no `simulators` resolves exactly as before (per-call lookup misses fall straight through to the unchanged global-registry/undefined path), so no existing scenario snapshot changes.
