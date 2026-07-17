---
"@tdk/core": minor
---

`compile()`'s `resolveValue` now recurses into an `env.pick(...)`'s picked branch instead of returning it verbatim. A branch that is a plain scalar compiled fine before; a branch OBJECT/ARRAY containing markers (`raw`, `nj()`, `jsonata()`, param refs) — or another `env.pick`, resolved against the same target env — previously aborted compilation with an unrendered-marker error, forcing authors to flatten per-env payloads into hand-written `${{ }}` strings. Those branches now render exactly like any other input subtree.

No flag: this only makes previously-erroring compiles succeed. A template that already compiled successfully used only scalar (or marker-free) branches, whose resolved output is unchanged — so no existing compiled artifact changes.
