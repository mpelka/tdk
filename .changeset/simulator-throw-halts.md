---
"@tdk/core": minor
---

snapshot-affecting: a throwing action simulator now HALTS the run as that step's failure, instead of rejecting the whole `execute()` call. `executeSpec` had two of its three step-failure paths halt-on-error (the BELT input-render catch, and the roadie `roadiehq:utils:jsonata` evaluate catch) — a registered action `simulate()` that throws was the third, unhandled path, escaping `execute()` entirely and crashing the harness instead of failing the step. It now gets the same treatment: the throw is caught, recorded as the step's `error` (output `undefined`), and the run halts — every step after it is `{ notReached: true }` and the template `output` is `undefined`, exactly like the other two failure paths.

**Scenario snapshots can newly capture a throwing simulator:** a scenario exercising an action whose registered simulator throws now gets a real (halted) snapshot instead of never completing. Run `tdk test -u` to accept any such new/changed snapshot. Scenarios whose simulators don't throw are unaffected.
