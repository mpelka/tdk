# @tdk/cli — the `tdk` command line

The `tdk` command drives [`@tdk/core`](../../packages/core): it compiles TDK templates to
Backstage YAML, runs their scenario snapshot tests, and scaffolds new ones. It is the
command surface behind the [VS Code extension](../vscode) too.

## Commands

| Command | What it does |
| --- | --- |
| `tdk compile <template>` | Compile one template to YAML and validate it against the Backstage schema. Prints to stdout, or writes with `-o`. |
| `tdk build [config]` | Compile the whole config — every template and target — validate every artifact, then write to disk. |
| `tdk execute <template>` | Run the template's scenarios through `execute()` and print one JSON result object. |
| `tdk test [path]` | Run scenario snapshot tests. Discovers testable templates, runs each scenario, and asserts against the stored snapshot. |
| `tdk init [dir]` | Scaffold a testable bakery template, its config, and the first snapshot into a directory. |

Run `tdk --help` for the full summary, or `tdk <command> --help` for one command.

## Options that matter

- `tdk compile` takes `-e, --env <env>` to compile for a named environment (defaults to
  `test`), `-o, --out <path>` to write instead of printing, and `--no-validate` to skip
  schema validation.
- `tdk build` reads `./tdk.config.ts` by default, or a path via `-c, --config`. Use
  `--stdout` to print every artifact instead of writing.
- `tdk test` writes a missing snapshot on first run, then compares on later runs. `-u`
  accepts fresh results, `--ci` fails on a missing snapshot and never writes, and `--list`
  lists templates and scenario names without running anything.
- `tdk compile` and `tdk execute` accept `--stdin` to read the template source from stdin,
  so an editor can compile an unsaved buffer.

## Read the docs

See the [CLI reference](../docs/reference/cli.md) for every command and option, and the
[testing guide](../docs/guide/testing.md) for the scenario snapshot model. Run the docs
site locally with `bun run --cwd apps/docs docs:dev`.
