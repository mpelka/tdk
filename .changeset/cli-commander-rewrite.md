---
"@tdk/cli": patch
---

The CLI's argument parsing is rewritten onto Commander (from a hand-rolled parser), with business logic moved into pure `src/lib/` modules. This is intended to be behavior-compatible: exit codes, the `file:line:col:` compile-error format, `--json`/`--list` output shapes, snapshot semantics, and config-relative build paths are all unchanged and were verified against the frozen CLI contract.

Two small flag-parsing regressions surfaced and were fixed before release: a value option that looked like a flag (e.g. `compile t.ts -o --env`) is now rejected instead of silently writing a file named `--env`, and short-flag `=` forms (`-o=path`, `-e=prod`) work again. The wording of flag/help error messages now comes from Commander and may differ slightly from the previous hand-written text — scripts that match on exact error text (rather than exit code) should be checked.
