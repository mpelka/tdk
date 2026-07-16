---
"@tdk/cli": minor
---

Add `tdk dry-run <paths...>`: batch-dry-run a sweep of templates against a live Backstage and report each outcome. It is the headless, CI-friendly counterpart to the VS Code dry-run, built on the new `@tdk/core/backstage` client — and it only ever dry-runs, never creates a task.

- Takes `.ts` and `.yaml` paths or globs, mixed, in one invocation (`Bun.Glob`). A `.ts` template compiles for `--env` (default `test`); a `.yaml` template is read via `fromYaml`.
- Values follow a fixed priority. For `.ts`: `--values <file>` > the named/first scenario fixture (`--scenario`) > `--synthesize-values`. For `.yaml`: `--values <file>` > a colocated `<basename>.values.json` sibling > `--synthesize-values`. An explicit `--values` always wins; when no source applies, that template reports a `valuesError` and never contacts Backstage.
- `--synthesize-values` derives a minimal payload from the template's own `spec.parameters` — property default, then first enum member, then a type-appropriate placeholder — for required fields only, and bails honestly (naming the fields) on a schema it cannot satisfy without inventing structure (a required object with no default, a typeless required field). Every synthesized run is flagged in the report.
- `--concurrency <n>` (default 4) caps parallelism; a 429 or 5xx is retried up to 3 times with a growing backoff. Config comes from `TDK_BACKSTAGE_URL` / `TDK_BACKSTAGE_TOKEN` (with a `--base-url` override; there is no `--token` flag — a token does not belong in argv). `--json` emits a machine-readable per-template report (path, source, kind, values source, synthesized flag, duration, status). The sweep exits 1 if any template did not dry-run `ok`.

Purely additive — a new command; every existing `tdk` command is unchanged.
