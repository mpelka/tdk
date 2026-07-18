---
"@tdk/cli": minor
---

tdk init scaffolds an authoring-v2 template (ADR-0025 phase 4, #19).

The starter `template.ts` `tdk init` writes is now the authoring-v2 shape: fields are
module-scope consts across a two-page table of contents, a `derive` computes a value
from them, and an `effect` is the side-effectful submit step whose typed handle the
`output` reads (the scaffold shows, in a comment, the pack helper a real project would
use in place of the inline `effect(...)`). It compiles to a `roadiehq:utils:jsonata`
step (the derive) plus the effect's own action step with inferred `ui:order`, and its
scenario mocks the effect output so `tdk test` in the new directory passes end to end
immediately. Replaces the v1 `{ parameters, steps }` starter.

Scaffold-output only: no change to how the CLI compiles or tests existing templates,
so no `output-changing:`/`snapshot-affecting:` flag applies.
