#!/usr/bin/env bun

// The `tdk` command line — a THIN Commander wiring layer over the pure, importable
// operations in `src/lib/*`. This file does exactly three things: DECLARE the
// commands/options (Commander), CALL the matching lib function, and MAP its result
// to stdout / stderr / `process.exitCode`. All business logic — compiling,
// building, executing scenarios, the snapshot engine, scaffolding, error
// formatting — lives in `src/lib` and is unit-tested there directly.
//
// Subcommands:
//   tdk                   print the help summary and exit 0 (no side effects)
//   tdk compile <file>    compile ONE template file, VALIDATE it against the
//                         Backstage schema (skippable with --no-validate), and
//                         print its YAML to stdout (or write it with -o)
//   tdk build [config]    compile the whole config (every template × target),
//                         validate EVERY artifact, then write them to disk —
//                         output paths resolve RELATIVE TO THE CONFIG FILE;
//                         --stdout prints instead of writing (still validates)
//   tdk execute <file>    run the template's sibling __fixtures__/scenarios.ts
//                         through execute() and print ONE JSON result object
//   tdk dry-run <paths>   batch-dry-run templates (.ts + .yaml, globs ok) against a
//                         live Backstage (TDK_BACKSTAGE_URL/_TOKEN) and report each
//                         outcome; exits non-zero if any run isn't ok (--json report)
//   tdk test [path]       run scenario SNAPSHOT tests (jest/vitest model).
//                         --list only lists templates + scenarios (never runs).
//   tdk migrate <m.json>  turn migration model(s) into template dir(s): validate,
//                         print v2 source + scenarios + report, smoke-compile.
//                         --validate-only stops at gate 0; --json for a report.
//   tdk init [dir]        scaffold a testable template + config + first snapshot
//   tdk --version         print the CLI version
//
// `compile` (single-file, stdout by default) and `execute` (scenario playground)
// are the single-file companions the VS Code extension shells out to; compile
// errors reach stderr as `file:line:col: message` (the extension's contract). An
// explicit file argument to `compile`/`execute` always means single-file mode —
// the config is only used by `build`.
//
// For a worked end-to-end example of consuming tdk from an outside project, see
// the sibling `tdk-playground` repo.

import { relative } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { buildConfig, buildStdout, compileTemplate, type Env, writeBuildJob } from "./lib/compile.ts";
import {
  type DryRunSweepOptions,
  expandPaths,
  formatDryRunReport,
  runDryRunSweep,
  serializeDryRunReport,
} from "./lib/dryRun.ts";
import { formatError } from "./lib/errors.ts";
import {
  executeInlineFixture,
  executeScenarios,
  parseInlineFixture,
  readInlineFixtureStdin,
  serializeExecuteReport,
} from "./lib/execute.ts";
import { runInit } from "./lib/init.ts";
import type { StdinRemap } from "./lib/load.ts";
import { formatMigrateReport, type MigrateOptions, runMigrate, serializeMigrateReport } from "./lib/migrate.ts";
import {
  anyFailure,
  emptyMessage,
  formatTestReport,
  listScenarios,
  resolveTestTargets,
  runTests,
  serializeListReport,
  serializeTestReports,
} from "./lib/test.ts";
import { startWatch, type WatchMessage } from "./lib/watch.ts";

/**
 * When a `--stdin` compile/execute routes through a unique temp sibling of the
 * real file, any error that escapes to the top-level catch has its temp path
 * re-pointed at the ORIGINAL path — so a caller's diagnostics land on the right
 * document. A module-level slot (instead of tagging the thrown value) survives
 * primitive throws (`throw "boom"`) and frozen/readonly error objects alike.
 */
let stdinRemap: StdinRemap | undefined;
const captureRemap = (remap: StdinRemap) => {
  stdinRemap = remap;
};

/**
 * Refuse a flag-looking token as a free-form value. Commander's default would
 * consume it — `compile t.ts -o --env` silently writing a file named "--env",
 * exit 0 — which the historical parser explicitly rejected.
 */
function pathValue(value: string): string {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError("requires a value (the argument looks like another flag).");
  }
  return value;
}

/** Parse a positive-integer option value (`--concurrency`, `--timeout`), rejecting junk. */
function positiveIntValue(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError("expects a positive integer.");
  }
  return n;
}

/**
 * Commander reads a short flag's `=` form as an ATTACHED value — `-o=x` means
 * value "=x", `-e=prod` means "=prod" — but the historical contract accepts
 * `-o=path`/`-e=prod`. Split `-X=value` into `-X value` before parsing.
 */
function splitShortFlagEquals(argv: string[]): string[] {
  return argv.flatMap((arg) => {
    const m = /^-([a-zA-Z])=(.*)$/.exec(arg);
    return m ? [`-${m[1]}`, m[2]] : [arg];
  });
}

/** The CLI's own version, read from the package.json next to this file's dir. */
async function cliVersion(): Promise<string> {
  const pkg = JSON.parse(await Bun.file(new URL("../package.json", import.meta.url)).text()) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

/**
 * Drive `startWatch` from the CLI: map the watcher's messages to stdout/stderr,
 * install the SIGINT handler (clean exit 0, stop watching), and BLOCK until that
 * signal. The lib owns all watching/rebuild logic and never touches `process`;
 * this adapter owns the streams, the signal, and the exit. Resolves on ⌃C.
 */
async function runWatch(configArg: string | undefined): Promise<void> {
  const emit = (msg: WatchMessage) => {
    (msg.stream === "err" ? process.stderr : process.stdout).write(msg.text);
  };
  const handle = startWatch(configArg, emit);
  process.stdout.write(`Watching ${handle.watchDir} for .ts changes — press ⌃C to stop.\n`);

  await new Promise<void>((resolve) => {
    const onSigint = () => {
      process.removeListener("SIGINT", onSigint);
      handle.close();
      process.stdout.write("\nStopped watching.\n");
      resolve();
    };
    process.on("SIGINT", onSigint);
  });
}

function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("tdk")
    .description("Template Development Kit CLI — compile TDK templates to Backstage YAML.")
    .version(`tdk ${version}`, "-v, --version", "print the CLI version")
    .showSuggestionAfterError()
    // Own the exit: throw a CommanderError instead of calling process.exit, so
    // buffered stdout/stderr always flush and the outer runner owns the code.
    .exitOverride();

  // tdk compile <template>
  program
    .command("compile")
    .description("Compile ONE template to YAML and validate it against the Backstage schema.")
    .argument("<template>", "path to the template.ts to compile")
    .option("-o, --out <path>", "write the compiled YAML to <path> (dirs created as needed)", pathValue)
    .addOption(new Option("-e, --env <env>", "compile for this env (any env name)").default("test"))
    .option("--stdin", "read the template source from stdin (unsaved buffer)")
    // Commander's native negation: `opts.validate` defaults true, false with --no-validate.
    .addOption(new Option("--no-validate", "skip the Backstage schema validation"))
    .action(async (template: string, opts: { out?: string; env: Env; stdin?: boolean; validate: boolean }) => {
      const outcome = await compileTemplate(template, {
        fromStdin: Boolean(opts.stdin),
        out: opts.out,
        env: opts.env,
        validate: opts.validate,
        onStdinRemap: captureRemap,
      });
      if (outcome.kind === "yaml") process.stdout.write(outcome.yaml);
    });

  // tdk build [config]
  program
    .command("build")
    .description("Compile the whole config (every template × target), validate EVERY artifact, then write to disk.")
    .argument("[config]", "config path (defaults to ./tdk.config.ts; also accepts -c)")
    .option("-c, --config <path>", "explicit config path (also accepts a positional path)", pathValue)
    // --stdout and --watch are mutually exclusive: a forever-reprinted stream of
    // multi-doc YAML is not useful, so refuse the combination up front.
    .addOption(
      new Option("--stdout", "print every artifact to stdout (separated by ---) instead of writing").conflicts("watch"),
    )
    .addOption(
      new Option("--watch", "rebuild on every .ts change under the config's dir (long-running; ⌃C to stop)").conflicts(
        "stdout",
      ),
    )
    .action(async (config: string | undefined, opts: { config?: string; stdout?: boolean; watch?: boolean }) => {
      // Preserve the historical precedence: an explicit -c/--config wins over the
      // positional path (both accepted forms), falling back to the default.
      const configArg = opts.config ?? config;

      if (opts.watch) {
        await runWatch(configArg);
        return;
      }

      const jobs = await buildConfig(configArg);
      if (opts.stdout) {
        process.stdout.write(buildStdout(jobs));
        return;
      }
      for (const job of jobs) {
        await writeBuildJob(job);
        process.stdout.write(`✓ ${job.templateId} → ${job.targetName}: ${job.outPath}\n`);
      }
      process.stdout.write(`\nCompiled ${jobs.length} artifact(s).\n`);
    });

  // tdk execute <template>
  program
    .command("execute")
    .description("Run the template's scenarios through execute() and print ONE JSON result object.")
    .argument("<template>", "path to the template.ts whose scenarios to run")
    .addOption(new Option("-e, --env <env>", "run for this env (any env name)").default("test"))
    .option("--stdin", "read the template source from stdin (unsaved buffer)")
    // The live-trace path: read ONE fixture as JSON from stdin and run just it
    // (never the sibling scenarios file). Mutually exclusive with --stdin, which
    // also claims stdin. The VS Code form preview posts the current form values
    // here to drive its per-step trace pane.
    .addOption(new Option("--fixture-stdin", "read ONE fixture as JSON from stdin and run just it").conflicts("stdin"))
    // Accepted for compatibility (the extension passes it) but a no-op & hidden:
    // JSON is the only output format `execute` has.
    .addOption(new Option("--json").hideHelp())
    .action(async (template: string, opts: { env: Env; stdin?: boolean; fixtureStdin?: boolean }) => {
      if (opts.fixtureStdin) {
        const fixture = parseInlineFixture(await readInlineFixtureStdin());
        const inline = await executeInlineFixture(template, fixture, opts.env);
        process.stdout.write(serializeExecuteReport(inline));
        return;
      }
      const report = await executeScenarios(template, {
        fromStdin: Boolean(opts.stdin),
        env: opts.env,
        onStdinRemap: captureRemap,
      });
      process.stdout.write(serializeExecuteReport(report));
    });

  // tdk dry-run <paths...>
  program
    .command("dry-run")
    .description("Batch dry-run templates (.ts and .yaml) against a live Backstage and report each outcome.")
    .argument("<paths...>", "template paths or globs (.ts and .yaml, mixed) to dry-run")
    .addOption(new Option("-e, --env <env>", "compile a .ts template for this env (any env name)").default("test"))
    .option("--scenario <name>", "for a .ts template, use this scenario's fixture (default: the first scenario)")
    .option("--values <file>", "an explicit JSON values file — wins over every other values source", pathValue)
    .option("--synthesize-values", "derive minimal values from the schema when no other source has them")
    .addOption(new Option("--concurrency <n>", "how many dry-runs run at once").default(4).argParser(positiveIntValue))
    .addOption(new Option("--timeout <ms>", "per-request timeout in milliseconds").argParser(positiveIntValue))
    .option(
      "--base-url <url>",
      "Backstage base URL (else TDK_BACKSTAGE_URL). The token comes from TDK_BACKSTAGE_TOKEN.",
      pathValue,
    )
    .option("--json", "emit a machine-readable per-template report")
    .action(
      async (
        paths: string[],
        opts: {
          env: Env;
          scenario?: string;
          values?: string;
          synthesizeValues?: boolean;
          concurrency: number;
          timeout?: number;
          baseUrl?: string;
          json?: boolean;
        },
      ) => {
        const files = await expandPaths(paths);
        const sweepOpts: DryRunSweepOptions = {
          env: opts.env,
          scenario: opts.scenario,
          valuesFile: opts.values,
          synthesizeValues: Boolean(opts.synthesizeValues),
          concurrency: opts.concurrency,
          timeoutMs: opts.timeout,
          baseUrl: opts.baseUrl,
        };
        const report = await runDryRunSweep(files, sweepOpts);
        if (opts.json) {
          process.stdout.write(serializeDryRunReport(report));
        } else {
          process.stdout.write(formatDryRunReport(report));
        }
        // Non-zero when ANY template did not dry-run ok (a pre-flight failure, a
        // validation/auth/server error, or an unreachable backend).
        if (!report.ok) process.exitCode = 1;
      },
    );

  // tdk test [path]
  program
    .command("test")
    .description("Run scenario SNAPSHOT tests (jest/vitest model).")
    .argument("[path]", "a directory to discover testable templates under, or a single template.ts (default .)")
    .option("--json", "machine-readable { templates: [...] } report")
    // Mutual exclusions: -u × --ci, and --list × both.
    .addOption(new Option("-u, --update", "accept fresh results (rewrites snapshots, prunes obsolete)").conflicts("ci"))
    .addOption(new Option("--ci", "fail on a missing snapshot / zero templates; never writes").conflicts("update"))
    .addOption(
      new Option("--list", "list templates + scenario names as JSON (never executes)").conflicts(["update", "ci"]),
    )
    .action(
      async (path: string | undefined, opts: { json?: boolean; update?: boolean; ci?: boolean; list?: boolean }) => {
        const { root, templates, empty } = await resolveTestTargets(path);
        if (empty) {
          // Zero discovered templates: a hard failure under --ci, a loud stderr warning otherwise.
          if (opts.ci) throw new Error(`tdk test: ${emptyMessage(root)}.`);
          process.stderr.write(`tdk test: warning — ${emptyMessage(root)}.\n`);
        }

        if (opts.list) {
          const result = await listScenarios(templates, root);
          process.stdout.write(serializeListReport(result));
          if (result.anyFailed) process.exitCode = 1;
          return;
        }

        const { reports, ms } = await runTests(templates, root, {
          update: Boolean(opts.update),
          ci: Boolean(opts.ci),
        });
        if (opts.json) {
          process.stdout.write(serializeTestReports(reports));
        } else {
          process.stdout.write(formatTestReport(reports, ms, Boolean(process.stdout.isTTY)));
        }
        // Non-zero if ANY scenario mismatched (a missing snapshot under --ci is
        // itself a `failed`) or a template failed to load/compile. Writes are not
        // failures.
        if (anyFailure(reports)) process.exitCode = 1;
      },
    );

  // tdk migrate <model.json...>
  program
    .command("migrate")
    .description("Turn migration model(s) into template dir(s): validate, print v2 source, and smoke-compile.")
    .argument("<models...>", "one or more migration model .json files (the ADR-0026 contract)")
    .option("--out <dir>", "directory to write <template-id>/ dirs into (default .)", pathValue, ".")
    .option("--mapping <file>", "an org action/lookup mapping (.json, or a .ts/.js default export)", pathValue)
    .option("--validate-only", "run gate 0 (schema + semantic) alone; write nothing")
    .option("--force", "overwrite an existing output directory (generate-once is the default)")
    .option("--json", "emit a machine-readable report")
    .action(
      async (
        models: string[],
        opts: { out: string; mapping?: string; validateOnly?: boolean; force?: boolean; json?: boolean },
      ) => {
        const migrateOpts: MigrateOptions = {
          out: opts.out,
          mapping: opts.mapping,
          validateOnly: Boolean(opts.validateOnly),
          force: Boolean(opts.force),
        };
        const result = await runMigrate(models, migrateOpts);
        if (opts.json) {
          process.stdout.write(serializeMigrateReport(result));
        } else {
          // Invalid-model diagnostics belong on stderr; the summary on stdout.
          const stream = result.ok ? process.stdout : process.stderr;
          stream.write(formatMigrateReport(result, migrateOpts.validateOnly));
        }
        // Non-zero if any model was invalid or any emission failed.
        if (!result.ok) process.exitCode = 1;
      },
    );

  // tdk init [dir]
  program
    .command("init")
    .description("Scaffold a testable template + config + first snapshot into [dir] (default .).")
    .argument("[dir]", "directory to scaffold into (default .)")
    .action(async (dir: string | undefined) => {
      const result = await runInit(dir);
      for (const file of result.files) process.stdout.write(`+ ${relative(process.cwd(), file)}\n`);
      process.stdout.write(`+ ${relative(process.cwd(), result.snapshot)}\n`);
      process.stdout.write(`\nScaffolded a testable TDK template in ${result.dir}. Try: tdk test ${dir ?? "."}\n`);
    });

  return program;
}

async function main() {
  const program = buildProgram(await cliVersion());
  const argv = process.argv.slice(2);

  // Bare `tdk` (or `tdk help`) — print the help summary to STDOUT and exit 0,
  // with no side effects. Commander's own no-args path writes help to stderr and
  // exits 1, so we handle it here to keep the historical contract.
  if (argv.length === 0) {
    process.stdout.write(program.helpInformation());
    return;
  }

  try {
    await program.parseAsync(splitShortFlagEquals(argv), { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already wrote help/version (exitCode 0) or the error message
      // (exitCode 1) to the right stream — just adopt its exit code. `> 0` is a
      // parse/usage failure; help/version are 0 and leave `exitCode` untouched.
      if (err.exitCode !== 0) process.exitCode = err.exitCode || 1;
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  let msg = formatError(err);
  if (stdinRemap) msg = msg.split(stdinRemap.from).join(stdinRemap.to);
  process.stderr.write(`${msg}\n`);
  // `exitCode` (not `process.exit`) so buffered stdout/stderr always flush.
  process.exitCode = 1;
});
