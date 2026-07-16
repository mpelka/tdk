---
"@tdk/core": minor
---

Add `fromYaml` and a scriptable Backstage client (`@tdk/core/backstage`).

- `fromYaml(text)` reads a plain-YAML Scaffolder template into the SAME `{ object, yaml }` artifact `compile()` produces, so a hand-authored YAML template flows into `validate`, the dry-run, and the task client exactly like a compiled TDK one. It returns a discriminated union — `{ kind: "template", object, yaml }`, `{ kind: "parseError", message, line? }`, or `{ kind: "notTemplate", reason }`. Single-document only; the root must carry `apiVersion` starting with `scaffolder.backstage.io/` and `kind: Template`. This is the plain-YAML detector extracted from the VS Code extension and generalized to hand back the compile artifact shape.

- A new `@tdk/core/backstage` subpath export ships the Backstage client. `backstageClient(config?)` resolves its base URL and token from explicit config, then the environment (`TDK_BACKSTAGE_URL` / `TDK_BACKSTAGE_TOKEN`); a request with no resolvable base URL throws a loud error naming both sources. It exposes `dryRun(artifact, { values, secrets? })` — the always-safe, no-side-effect path, returning the existing discriminated taxonomy (`ok` / `validationFailed` / `authFailed` / `serverError` / `unreachable`, token never logged) — and `createTask(artifact, { values, secrets? })`, which POSTs a real scaffolder task (`POST /api/scaffolder/v2/tasks`) and returns the new task id plus a link-able URL. `createTask` sits behind a consent gate: it throws synchronously unless the client was built with `allowTaskCreation: true`, because a task runs the template for real. Both accept the `{ object, yaml }` artifact that `compile()` and `fromYaml()` return. The low-level `dryRun` and its taxonomy types are also exported for the VS Code extension, which now consumes this module instead of its own copy.

Purely additive — no existing `@tdk/core` export changes, and compiled YAML and `execute()` output are untouched (no scenario snapshots move).
