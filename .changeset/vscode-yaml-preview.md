---
"tdk-vscode": minor
---

Form preview for plain YAML Scaffolder templates, plus a `TDK: Set Backstage Base URL` command.

- `TDK: Open Form Preview` now works when the active editor holds a plain YAML file that is a Scaffolder template (`apiVersion` starting with `scaffolder.backstage.io/` and `kind: Template`). The preview pipeline is source-agnostic after "compiled YAML", so the CLI compile is skipped entirely: the live editor buffer is the artifact, parsed (debounced, like the TS path) straight into the form. A YAML syntax error renders in the existing compile-error banner with a `file:line` location; the last good form stays on screen.
- The env selector, scenario picker, save-as-scenario, and the local execute trace are TDK-compile concepts, so a YAML source hides them (webview) and guards them (extension), with a quiet one-line note in the panel naming why. Dry-run in Backstage works fully — it posts the parsed buffer entity as-is.
- The `template` protocol message carries a new optional `source: "tdk" | "yaml"` discriminator (absent = `tdk`, so older messages behave unchanged).
- New `TDK: Set Backstage Base URL` palette command: an InputBox pre-filled with the current `tdk.backstage.baseUrl`, validated live (empty clears the setting and turns the dry-run off; anything else must parse as an http/https URL), written to the global setting. The dry-run's missing-setup prompt now offers this command alongside the settings UI.
