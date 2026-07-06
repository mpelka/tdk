---
"@tdk/core": major
---

`compile()` now throws when a `jsonata(...)` (or `raw.jsonata`) expression is used as a `${{ }}` interpolation value — a step input, a step `if`, or an output. Backstage's `${{ }}` is Nunjucks and can never evaluate JSONata, so this shape previously compiled to plausible-looking YAML that was wrong by construction.

**Breaking.** Any template that put a `jsonata()` expression directly into a `${{ }}` slot now fails to compile, with an error naming the step id and key path. Migrate by either moving the expression into a Backstage `expression:` field via the `.jsonata` accessor, or rewriting the logic with `nj()` so it evaluates as Nunjucks inside `${{ }}`. `execute()` also now surfaces the equivalent Nunjucks parse failure as the step's `error` (instead of throwing uncaught), matching how a roadie-run template would fail.

Bump level: pre-1.0, so a minor would be the conventional way to mark this breaking change; `major` is used here to flag it unambiguously in the changelog (0.x semantics still apply — see AGENTS.md).
