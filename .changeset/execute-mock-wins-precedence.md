---
"@tdk/core": minor
---

`execute()` now prefers an explicit fixture step mock over a registered action simulator (mock-wins precedence). A simulator only runs when the scenario supplies no mock for that step. Presence is checked on the fixture entry itself, so an explicit `{ output: undefined }` mock still wins over a registered simulator.

This is additive/corrective: templates whose scenarios already provide step mocks are unaffected; templates relying on a plugin-registered simulator continue to work exactly as before whenever a scenario omits a mock for that step.
