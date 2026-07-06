# The VS Code extension

The TDK VS Code extension is the developer surface for `@tdk/core`. It gives you a
live compile preview, an interactive form preview, a two-slot trace panel, a dry-run
against a real Backstage, and every template's scenarios wired into the native Test
Explorer. This page walks the workflow in order, from install to Test Explorer.

Everything here shells out to the `tdk` CLI in your workspace — the extension bundles
no compiler of its own, so the preview always matches the version your project builds
with.

## Install and build

The extension is not published to a marketplace yet. Build it from the monorepo and
load the resulting package into VS Code.

```sh
bun install        # from the monorepo root
bun run --cwd apps/vscode build   # bundle src/ -> dist/ (extension host + two webview apps)
```

The build produces three bundles from one package through `Bun.build`, not esbuild
or vite: the extension host (`dist/extension.js`, Node and CommonJS, with `vscode`
left external) and the two webview apps — the form panel and the TDK Trace view
(both targeting the browser, sharing one build so React, RJSF and Fluent are a single
copy). To iterate, run `bun run --cwd apps/vscode watch` and press F5 in VS Code to
launch an Extension Development Host.

To hand the extension to a teammate, package it into a `.vsix` with `vsce`:

```sh
bunx @vscode/vsce package --no-dependencies   # in apps/vscode, produces tdk-vscode-<version>.vsix
```

The `--no-dependencies` flag is required: vsce's dependency scan shells out to
`npm list`, which fails on the Bun workspace layout, and the build already bundles
everything into `dist/`.

They install it with `code --install-extension tdk-vscode-<version>.vsix` or through
the Extensions view's Install from VSIX command. The `publisher` field in
`apps/vscode/package.json` is a placeholder until the marketplace track is set up, so
`vsce publish` is not wired yet.

## The extension finds your workspace CLI

Every feature shells out to a `tdk` binary. The extension resolves it in a fixed
order, first match wins:

1. the `tdk.cliPath` setting — an absolute path you set explicitly
2. the workspace's own `node_modules/.bin/tdk`
3. a `tdk` on the extension host's `PATH`
4. `~/.bun/bin/tdk`, where `bun link` puts a globally linked CLI

There is no `npx tdk` or `bunx tdk` fallback, on purpose. The `tdk` package on the
npm registry is an unrelated third party's package, and piping your template source
to it would be a security hazard. When no binary is found, the extension fails with
an actionable message naming every location it searched, in the status bar, the
compile-preview notification, and any failing test.

The workspace binary is the preferred default because the CLI and your template then
resolve one copy of `@tdk/core`, which keeps the DSL's module-identity checks intact.
Set `tdk.cliPath` only when your CLI lives somewhere the chain does not find it.

## Compile preview

Run `TDK: Compile Preview` from an active `.ts` template inside an open workspace
folder. The compiled Backstage YAML opens read-only beside the source and recompiles,
debounced, on every keystroke.

- The preview reflects your current buffer, unsaved edits included. The extension
  spawns `tdk compile --stdin <file>` and pipes the editor buffer to its stdin.
- A failed compile is non-destructive: the last good YAML stays on screen, and the
  error shows as a diagnostic in the Problems panel — a squiggle on the source line,
  placed from the CLI's `file:line:col` — plus a quiet status-bar indicator.
- `tdk compile` validates against the Backstage schema by default, so the preview
  catches schema errors, not just build or transpile ones.

## Form preview

Run `TDK: Open Form Preview` from an active `.ts` template to open a webview beside
the source. It compiles the template, reads `spec.parameters`, and renders the
parameter form. This is a behavioural preview — the right fields, pages, validation
and payload — not a copy of the Backstage look.

The form uses React JSON Schema Form (RJSF), the same form engine Backstage itself
uses. Its `dependencies` and `oneOf` semantics, required handling and ajv validation
all come from RJSF, so the preview stays honest about how Backstage will behave. The
theme is Fluent UI, so the form follows your editor theme rather than mimicking
Backstage's look — behavioural fidelity matters here, visual fidelity does not.

The controls mirror a Backstage wizard:

- the form is a stepper, one page at a time; Next validates the current page before
  it advances, Previous goes back, and a final review step shows the values as JSON
- Reset clears every value back to the schema defaults in one click, with no confirm
- the env selector, shown in the header, recompiles for that environment so you see
  what `load()` and `env.pick` bake in
- the scenario selector prefills the form from a saved scenario in
  `__fixtures__/scenarios.ts` and returns you to page one
- Save as scenario prompts for a name and writes the current form values as a new
  scenario entry in `__fixtures__/scenarios.ts`

An unknown custom `ui:field` the preview cannot render falls back to a labelled input
that names the field, rather than crashing the form. A compile error arrives as a
dismissable banner and keeps the last good form on screen.

## The TDK Trace panel

The TDK Trace panel is a debugger-style view in the panel area, a tab beside Test
Results. It retains two slots side by side, switched by a control at the top:

- Local simulate — the offline `execute()` trace, live as you edit the form
- Backstage dry-run — the last real dry-run against a live Backstage

Both slots persist until replaced. A finished dry-run fills its slot and switches the
view to it, but the local trace is one click away, and the reverse holds too. The
point of two retained slots is the comparison: the same form values run through the
local simulator and through the real engine are a differential view. A dry-run's
steps are normalized into the same trace shape the local trace uses, so one detail
component renders both.

### What each slot shows

Both slots use a master-detail layout: a left rail of the steps in execution order,
and a detail pane for the selected step. The detail pane shows the step's inputs with
provenance, its output, and the context it could see. A dry-run step adds its run log,
and the dry-run slot adds a Files section and an endpoint header on top.

### The glyph legend

Each step in the rail carries a status glyph:

- `✓` — the step ran
- `⤼` — the step was skipped because its `if:` condition was false
- `✗` — the step errored
- `○` — the step was not reached, because an earlier step errored and halted the run

A not-reached step is selectable, but its detail is a single line: the run halted at
the first failed step. This mirrors real Backstage, which stops a task at the first
failed step. A skip does not halt the run, so steps after a skip still run.

### Provenance rows

Each input renders as a provenance row that shows where the value came from:

- `key: expression → value` when the input is a <code v-pre>${{ … }}</code> expression that
  resolved
- `key: expression` when the input is an expression but no value was recovered — a
  step that never ran, for example a skipped `if:`
- `key: value` when the input is a plain literal

The expression-only form is deliberate. When a value cannot be recovered, the row
shows the expression alone. It never fabricates a value or shows `undefined` — a
never-guess rule that keeps the trace honest.

### Gating

The local slot is validity-gated. An invalid form — one missing required fields —
does not run `execute()`, because the resulting error trace teaches wrong lessons.
Instead the slot shows one of two things:

- a quiet placeholder listing the missing fields, when no valid trace exists yet
- your last valid trace under a slim banner, when the form was valid before you
  started editing, so a mid-edit form keeps its last good simulate on screen

A YAML source has no local simulate at all — the slot shows the same explanatory note
the form panel does.

## Dry-run in Backstage

`execute()` simulates a run offline. A dry-run runs the same template against a real
Backstage, so you can check the parts the simulator does not cover: how the server
validates the form values, which steps run, and what files the template emits.

### Set-up commands

Two things need setting up first:

1. Run `TDK: Set Backstage Base URL`, or set `tdk.backstage.baseUrl` directly, to
   your Backstage URL, for example `http://localhost:7007`.
2. Run `TDK: Set Backstage Token` to store a bearer token.

The token lives in VS Code SecretStorage, never in a settings file, and an empty
submit clears it. The token is optional — some backends allow an unauthenticated
dry-run — but a token that Backstage rejects surfaces as an auth error pointing back
at the command.

The Dry-run in Backstage button on the review step is gated on the base URL. Until
the base URL is set the button is disabled, with a hint naming the commands that fix
it. Setting the base URL re-enables the button live.

### Running a dry-run

Open the form preview, fill the form, and on the review step select Dry-run in
Backstage. The extension compiles the current environment's template and posts it with
the current form values to Backstage's `/api/scaffolder/v2/dry-run` endpoint. The
result lands in the trace panel's Backstage dry-run slot, under an endpoint header
showing the base URL, the HTTP status and the run duration, so you can always tell
which server produced the trace.

The run log is de-noised on the way in: the inputs JSON blob is collapsed to a short
note, the routine `info:` level prefix is stripped, and warnings and errors are kept
and marked. Resolved values are recovered from the log best-effort — where a value
cannot be recovered, the row falls back to the expression-only form.

### The outcomes

A dry-run ends in one of these states:

- a run trace — each step with its status and log lines, the template output, and any
  emitted files
- a validation failure — the server-side errors from a rejected payload, listed by
  field, which is free validation even for custom fields the simulator cannot check
- an auth failure — the token is missing, expired or rejected, with a message pointing
  at the token command
- a connection failure or a server error (such as a 5xx from a malformed template) —
  a single message naming what went wrong

Emitted files show in a Files section. Select a path to open its content as a
read-only document; an executable file carries a badge.

### Run history

The extension keeps a history of dry-runs per preview, up to 20. The endpoint header
shows `Run N of M` with `‹` and `›` buttons to step through older and newer runs; `‹`
is disabled at the oldest run, `›` at the newest. A failed run is tagged in the
indicator with its failure kind.

### A note on step counts

In our testing, Backstage's task banner in the run log counts one implicit trailing
step beyond what your template declares — a three-step template starts up as a task
with four steps. That extra step emits no log line, so the step rail still shows
exactly your steps. Do not read the banner's count as a bug in your template.

## Preview plain YAML templates

`TDK: Open Form Preview` also works on a plain YAML Scaffolder template — a file whose
`apiVersion` starts with `scaffolder.backstage.io/` and whose `kind` is `Template`.
There is no compile step: the editor buffer is the template, so the form renders
straight from `spec.parameters` and updates, debounced, as you type.

For a YAML source, the form, its validation and Dry-run in Backstage all work exactly
as they do for a `.ts` template. A YAML syntax error shows in the same error banner
with a line number. What does not work is anything that needs a `template.ts` source:
scenarios, the local execute trace, and the environment selector. The panel hides
those and says so in a one-line note, so their absence reads as intentional.

This is the adoption path. A team can point the form preview and a dry-run at their
existing YAML templates with zero commitment to the DSL, then adopt TDK for the
templates where the typed authoring earns its keep.

## Scenarios in the Test Explorer

Every testable template's scenarios run through VS Code's built-in Testing view, with
no custom panel. A workspace-wide TDK Scenarios test controller surfaces every
testable template — a directory holding both `template.ts` and
`__fixtures__/scenarios.ts` — as a test suite, with each scenario as a test under it.

- Discovery is workspace-wide and editor-independent. Suites populate on activation
  and refresh, debounced, whenever a `template.ts` or its `__fixtures__/scenarios.ts`
  is added, changed or removed. Each suite's scenarios come from `tdk test --list`, a
  side-effect-free listing that never runs a scenario or touches a snapshot. A
  scenario's `branches[]` attach as test tags, so you can filter by them.
- Run a suite or a single scenario with the inline play button. The handler shells out
  to `tdk test --json`, which snapshot-tests each scenario, and appends a per-step
  resolved trace to the run output.
- A mismatch shows as a failing test with VS Code's native expected-against-actual
  diff. The Update Snapshots run profile re-runs with `tdk test -u` and accepts the
  current output as the new snapshot, so you can approve a change without leaving the
  editor.

Running a scenario compares its compiled result to a stored snapshot — the jest and
vitest model — so the Test Explorer does real regression testing, not just a check
that it ran cleanly. The snapshot logic lives in the CLI, the single source of truth;
the extension renders the result. Commit the `__snapshots__/` files alongside your
templates and review their diffs like any other code.

See [Test templates](/guide/testing) for the scenario-fixture and snapshot model, and
the [CLI reference](/reference/cli) for the commands the extension drives.
