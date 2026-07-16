# CLI reference

The full `tdk` command line: every command, argument, flag, exit code and the
`--stdin` contract. This reference is verified against `apps/cli/src/cli.ts` and the
operation modules in `apps/cli/src/lib/`.

```
Usage: tdk [options] [command]

Template Development Kit CLI — compile TDK templates to Backstage YAML.

Options:
  -v, --version                 print the CLI version
  -h, --help                    display help for command

Commands:
  compile [options] <template>  Compile ONE template to YAML and validate it
                                 against the Backstage schema.
  build [options] [config]      Compile the whole config (every template ×
                                 target), validate EVERY artifact, then write to
                                 disk.
  execute [options] <template>  Run the template's scenarios through execute()
                                 and print ONE JSON result object.
  dry-run [options] <paths...>  Batch dry-run templates (.ts and .yaml) against a
                                 live Backstage and report each outcome.
  test [options] [path]         Run scenario SNAPSHOT tests (jest/vitest model).
  init [dir]                    Scaffold a testable template + config + first
                                 snapshot into [dir] (default .).
  help [command]                display help for command
```

Per-command help is available via `tdk <command> --help`.

## Global behaviour

- Bare `tdk` (and `tdk help`) prints the help summary to stdout and exits 0, with no
  side effects.
- `tdk -v` / `tdk --version` prints the CLI version and exits 0.
- An unknown command or a usage error (a missing required argument, a flag-looking
  value) exits with a non-zero code, the message on stderr.
- Any operation failure — a compile error, a validation failure, a missing template
  — writes the formatted error to stderr and sets exit code 1.

### Flag parsing

- A short flag accepts an attached `=` value: `-o=path` and `-e=prod` are split into
  `-o path` and `-e prod` before parsing.
- A free-form value that looks like a flag is refused. `tdk compile t.ts -o --env`
  errors rather than writing a file named `--env`.

### The `--stdin` contract

`compile` and `execute` accept `--stdin` to read the template source from stdin — the
editor's unsaved buffer. The source is written to a unique temp sibling of the given
`<template>` path, so relative imports and `@tdk/core` resolve exactly as for the
real file, and Bun's module cache never returns stale content. The temp file is
always removed afterwards. Any error is reported against the original path, not the
temp path.

For `execute --stdin`, the scenarios are always loaded from the real on-disk
`__fixtures__/scenarios.ts`, independent of the piped buffer.

## `tdk compile`

Compile one template to YAML and validate it against the Backstage schema. By
default the YAML prints to stdout.

```
Arguments:
  template          path to the template.ts to compile

Options:
  -o, --out <path>  write the compiled YAML to <path> (dirs created as needed)
  -e, --env <env>   compile for this env (any env name) (default: "test")
  --stdin           read the template source from stdin (unsaved buffer)
  --no-validate     skip the Backstage schema validation
  -h, --help        display help for command
```

- The template file must export a `defineTemplate(...)` value, as the default export
  or a named export. The default export is preferred, then named exports in
  declaration order; the first `Template` value wins. If none is found, `tdk compile`
  errors and exits 1.
- `-e/--env` is any environment name (default `test`). Environment-safety is always
  on: a literal in this artifact that is exclusive to a different environment is a
  leak regardless of which environment you compiled for, and it fails the compile.
- `--no-validate` skips the schema validation only; the compile and the leak check
  still run.
- With `-o`, the YAML is written to that path (parent directories created) and
  nothing prints to stdout.

`compile` is one of the single-file companions the VS Code extension shells out to.
Compile errors reach stderr as `file:line:col: message`.

## `tdk build [config]`

Compile the whole config — every template times every target — validate every
artifact, then write them to disk.

```
Arguments:
  config               config path (defaults to ./tdk.config.ts; also accepts -c)

Options:
  -c, --config <path>  explicit config path (also accepts a positional path)
  --stdout             print every artifact to stdout (separated by ---) instead of writing
  --watch              rebuild on every .ts change under the config's dir (long-running; ⌃C to stop)
  -h, --help           display help for command
```

- The config must default-export `defineConfig({ templates, targets })`. A config
  missing either key errors and exits 1.
- An explicit `-c/--config` wins over the positional `config` path; with neither, the
  default `./tdk.config.ts` is used.
- Output paths resolve relative to the config file, not the current working
  directory. Each target sets `outDir` (then the path is
  `<outDir>/<id>/template.yaml`) or its own `out(meta)` function; a target with
  neither errors.
- Everything is compiled and validated before anything touches disk, so an invalid
  artifact never leaves a half-written output tree.
- `--stdout` prints every artifact to stdout, separated by a `---` document marker,
  instead of writing (it still validates). Otherwise `tdk build` prints one progress
  line per artifact and a final count.

### `--watch`

`tdk build --watch` runs the build once, then keeps running and rebuilds on every
change. Use it for a live preview loop — a compiled output dir that another tool
watches.

- It runs the initial build immediately, then watches the config file's directory,
  recursively, for `.ts` changes. Each surviving change triggers a debounced
  (150ms) full rebuild — the same compile, validate and write as a plain `tdk build`.
- It ignores changes inside the output dirs, `node_modules`, `__snapshots__`, and any
  dotdir, so its own writes never retrigger it.
- A failing build prints the error and keeps watching; the next save retries. Press
  ⌃C to stop (exit 0).
- v1 watching is coarse: any `.ts` change rebuilds every template and target, not
  just the affected ones. It does not follow the import graph.
- `--watch` cannot be combined with `--stdout`.

## `tdk execute`

Run the template's scenarios through `execute()` and print one JSON result object.

```
Arguments:
  template         path to the template.ts whose scenarios to run

Options:
  -e, --env <env>   run for this env (any env name) (default: "test")
  --stdin           read the template source from stdin (unsaved buffer)
  --fixture-stdin   read ONE fixture as JSON from stdin and run just it
  -h, --help        display help for command
```

- Scenarios are read from the sibling `__fixtures__/scenarios.ts`. A missing
  scenarios file is simply zero scenarios (the template still previews). A file that
  fails to load or lacks a `scenarios` export throws and exits 1, the same as a
  template-level failure.
- The template is compiled once up front, so a template-level compile error surfaces
  as one top-level failure rather than one per scenario.
- The report is always `{ ok: true, scenarios: [...] }`. Each scenario yields either
  `{ name, branches, result }` or `{ name, branches, error }`, plus additive
  `parameters` (the fixture values) and `hasStepMocks` (whether it carries `steps`
  mocks) — the form preview reads those to prefill and drive its trace. One bad
  scenario never sinks the rest, and the exit code is 0 even when a scenario errored —
  read the per-scenario `error` in the JSON.
- A `--json` flag is accepted for compatibility (the VS Code extension passes it) but
  is a no-op: JSON is the only output format.

### `--fixture-stdin` (the live-trace path)

`tdk execute --fixture-stdin <template>` reads ONE fixture as JSON from stdin and runs
just it — the sibling `scenarios.ts` is never touched. The fixture is a
`{ parameters, secrets?, user?, steps?, loaded? }` object (only `parameters` is
required). The report is a single run's outcome: `{ ok: true, result }`, or
`{ ok: false, error }` when the run threw. It is mutually exclusive with `--stdin`
(stdin already carries the fixture). The VS Code form preview posts the current form
values here to render its per-step trace pane.

`execute` is the single-file scenario playground the VS Code extension shells out to.

## `tdk dry-run <paths...>`

Dry-run a sweep of templates against a live Backstage and report each outcome. It is
the batch, headless counterpart to the VS Code dry-run: point it at a set of paths
(or globs, mixed `.ts` and `.yaml`) and it compiles or reads each one, sources its
values, posts a dry-run to Backstage, and prints a per-template report. It only ever
dry-runs — it never creates a task — so it is safe to run in CI.

```
Arguments:
  paths                template paths or globs (.ts and .yaml, mixed) to dry-run

Options:
  -e, --env <env>      compile a .ts template for this env (any env name) (default: "test")
  --scenario <name>    for a .ts template, use this scenario's fixture (default: the first scenario)
  --values <file>      an explicit JSON values file — wins over every other values source
  --synthesize-values  derive minimal values from the schema when no other source has them
  --concurrency <n>    how many dry-runs run at once (default: 4)
  --timeout <ms>       per-request timeout in milliseconds
  --base-url <url>     Backstage base URL (else TDK_BACKSTAGE_URL). The token comes from TDK_BACKSTAGE_TOKEN.
  --json               emit a machine-readable per-template report
  -h, --help           display help for command
```

### Configuration

The base URL comes from `--base-url`, or the `TDK_BACKSTAGE_URL` environment variable
when the flag is absent. The token comes only from `TDK_BACKSTAGE_TOKEN` — there is no
`--token` flag, because a token in `argv` would leak into your shell history and
process list. A request with no resolvable base URL fails loudly, naming both sources.

### Values sources

Every dry-run needs parameter values. Where they come from depends on the file type,
and follows a fixed priority.

For a `.ts` template:

1. `--values <file>`, an explicit JSON file, if given.
2. the scenario fixture — `--scenario <name>`, or the first scenario when the
   template has a sibling `__fixtures__/scenarios.ts`.
3. `--synthesize-values`, if given.

For a `.yaml` template:

1. `--values <file>`, an explicit JSON file, if given.
2. a colocated `<basename>.values.json` sibling — for `cake-order.yaml`, the file
   `cake-order.values.json` in the same directory.
3. `--synthesize-values`, if given.

When no source applies, that template reports a `valuesError` and never contacts
Backstage. An explicit `--values` file always wins.

### Synthesized values

`--synthesize-values` derives a minimal payload from the template's own
`spec.parameters` schema, for the required fields only. Each required field takes its
property `default`, then the first `enum` member, then a type-appropriate placeholder
(`"example"` for a string, `1` for a number, `false` for a boolean, `[]` for an
array). Optional fields are left out.

The synthesizer is deliberately small and honest. It bails — reporting a `valuesError`
that names the fields — on a schema it cannot satisfy without inventing structure: a
required object with no default, or a typeless required field. Every synthesized run
is flagged in the report, so a placeholder pass is never mistaken for a real one.

### Concurrency and backoff

`--concurrency <n>` (default 4) caps how many dry-runs run at once. Within that cap,
a dry-run that returns a 429 or a 5xx is retried up to 3 times with a growing backoff
(250ms, 500ms, 1000ms), so a rate-limited or briefly overloaded backend is not
reported as a hard failure on the first blip.

### Report and exit code

The default output is one status line per template — its outcome, values source, a
synthesized flag, the duration, and any error message — then a summary count.
`--json` emits a machine-readable report instead:

```json
{
  "ok": false,
  "templates": [
    { "path": "…/cake-order.yaml", "source": "yaml", "kind": "ok",
      "ok": true, "valuesSource": "colocated", "synthesized": false, "durationMs": 57 }
  ]
}
```

Each template's `kind` is either a pre-flight failure that never reached Backstage
(`notTemplate`, `parseError`, `loadError`, `compileError`, `valuesError`) or a dry-run
outcome (`ok`, `validationFailed`, `authFailed`, `serverError`, `unreachable`). The
sweep exits 1 if any template did not dry-run `ok`, so CI fails on the first drift.

See [Dry-run against Backstage](/guide/testing#dry-run-against-backstage) for the
scriptable client the command is built on, and the consent-gated `createTask`.

## `tdk test [path]`

Run scenario snapshot tests (the jest/vitest model).

```
Arguments:
  path          a directory to discover testable templates under, or a single
                template.ts (default .)

Options:
  --json        machine-readable { templates: [...] } report
  -u, --update  accept fresh results (rewrites snapshots, prunes obsolete)
  --ci          fail on a missing snapshot / zero templates; never writes
  --list        list templates + scenario names as JSON (never executes)
  -h, --help    display help for command
```

The snapshot outcomes per scenario:

- no stored snapshot — write it, status `written` (this is a `failed` under `--ci`,
  which never writes)
- stored and structurally equal — `passed`
- stored and different — `failed`, with an expected/actual YAML diff (the stored
  snapshot is preserved, never overwritten on a normal run)
- stored and different under `-u` — the fresh result is accepted, status `updated`

Persistence: on a normal run the file is rewritten only when a new snapshot was
written; under `-u` the whole file is rewritten and obsolete entries (in the file but
no longer a scenario) are pruned. Outside `-u`, obsolete entries are warned about and
kept.

Flags and mutual exclusions:

- `-u/--update` and `--ci` conflict; `--list` conflicts with both.
- `--json` prints a machine-readable `{ templates: [...] }` report.
- `--list` lists templates and scenario names as JSON and never executes.

Exit codes:

- Exit 1 if any scenario mismatched, any template failed to load or compile, or
  (under `--ci`) any snapshot was missing. A missing snapshot under `--ci` is itself
  a `failed`.
- Zero discovered templates is a hard failure under `--ci`; otherwise it is a stderr
  warning and the run continues.
- `--list` exits 1 if any listed template's scenarios file failed to load.
- Writing a snapshot is not a failure.

See [Test templates](/guide/testing) for the scenario-fixture and snapshot model this
command drives.

## `tdk init [dir]`

Scaffold a testable template, config and first snapshot into `[dir]` (default `.`).

```
Arguments:
  dir         directory to scaffold into (default .)

Options:
  -h, --help  display help for command
```

Writes a bakery `template.ts`, its `__fixtures__/scenarios.ts`, a `tdk.config.ts` and
the first snapshot baseline, then prints one `+ <path>` line per written file. See
[Get started](/guide/getting-started) for the full walkthrough.
