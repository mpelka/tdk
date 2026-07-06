---
"tdk-vscode": minor
---

Add "Dry-run in Backstage" to the form preview (issue #3, phase 3). The Review step gains a Dry-run in Backstage button: the extension compiles the current env's template, POSTs it to a real Backstage `/api/scaffolder/v2/dry-run`, and renders the outcome in the TDK Trace panel as a distinct, labeled Backstage-dry-run result alongside the local execute trace.

- Base URL via the new `tdk.backstage.baseUrl` setting; the bearer token via VS Code SecretStorage, set with the `TDK: Set Backstage Token` command (never stored in settings). Missing setup prompts the user with a link to the setting and command.
- The result classifies into `ok` (per-step status + log lines grouped by step, the template output, and emitted files), `validationFailed` (the server-side 400 `{ errors }` rendered readably), `authFailed`, and unreachable/server errors.
- Emitted `directoryContents` render as a Files section — each path opens its decoded content as a read-only virtual document (the `tdk-dryrun` scheme); the executable bit shows as a badge; an empty list is a quiet note.

The dry-run client is a pure, fetch-injectable module with unit tests for every classification plus a gated live-Backstage integration test. The org-side custom field pack intentionally lives outside this repo.
