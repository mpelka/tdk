// `tdk execute` — run a template's scenarios through core's `execute()` and
// produce ONE JSON report object. Pure: it returns the report (and a serializer
// for it); `cli.ts` writes it to stdout. The `--stdin` temp-file lifecycle and
// the error remap live here too, but no stream/exit side effects.

import { resolve } from "node:path";
import { compileResolved, type ExecuteResult, execute, type TemplateInput } from "@tdk/core";
import type { Env } from "./compile.ts";
import { formatError } from "./errors.ts";
import {
  importTemplateInput,
  loadScenarios,
  readStdin,
  type Scenario,
  type StdinRemap,
  safeJson,
  withStdinTempFile,
} from "./load.ts";

/**
 * Additive scenario metadata the VS Code form preview needs but `execute()` does
 * not itself surface: the fixture's PARAMETER values (to PREFILL the form), whether
 * it carries step MOCKS, and — when it does — the mocks themselves (so the live
 * trace can reuse them as its run base without re-parsing the scenarios file). All
 * three ride on every `ScenarioOutcome`, alongside `result`/`error` — a scenario
 * reports its inputs even when its run threw. Older readers that only look at
 * `name`/`result`/`error` are unaffected (these are purely additive fields).
 */
export interface ScenarioInputs {
  /** The fixture's `parameters` — the exact values a scenario prefill drops into the form. */
  parameters?: unknown;
  /** True when the fixture supplies `steps` mocks (the trace reuses them as its base). */
  hasStepMocks: boolean;
  /** The fixture's `steps` mocks, when present — the trace's base fixture reuses these. */
  steps?: Record<string, { output: unknown }>;
}

/** Per-scenario outcome: a successful run, or the error its `execute()` threw. */
export type ScenarioOutcome =
  | ({ name: string; branches?: string[]; result: ExecuteResult } & ScenarioInputs)
  | ({ name: string; branches?: string[]; error: string } & ScenarioInputs);

/** The top-level `tdk execute` report — always `{ ok: true, scenarios: [...] }`. */
export interface ExecuteReport {
  ok: true;
  scenarios: ScenarioOutcome[];
}

/**
 * A single inline fixture supplied on stdin (`execute --fixture-stdin`), run
 * WITHOUT touching the sibling scenarios file. `parameters` is required; the rest
 * mirror `ExecuteFixture`. The VS Code form preview posts the LIVE form values
 * here (as `parameters`), optionally merged over a selected scenario's `steps`
 * mocks, to drive the per-step trace pane.
 */
export interface InlineFixture {
  parameters: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  user?: Record<string, unknown>;
  steps?: Record<string, { output: unknown }>;
  loaded?: unknown;
}

/** The `execute --fixture-stdin` report — ONE run's outcome (or the error it threw). */
export type InlineExecuteReport = { ok: true; result: ExecuteResult } | { ok: false; error: string };

/** Options for the execute operation. */
export interface ExecuteOptions {
  fromStdin: boolean;
  env: Env;
  /** Remap callback for a `--stdin` temp-file error (see `compile.ts`). */
  onStdinRemap?: (remap: StdinRemap) => void;
}

/**
 * Run every scenario in the template's sibling `__fixtures__/scenarios.ts`
 * through `execute()` and return ONE report object — `{ ok: true, scenarios }`.
 * Each scenario yields either `{ name, branches, result }` or `{ name, branches,
 * error }`, so one bad scenario never sinks the rest.
 *
 * Scenarios are loaded from `<dir(file)>/__fixtures__/scenarios.ts`. A MISSING
 * fixtures file is simply ZERO scenarios — so a template with no fixtures still
 * previews cleanly — but a file that FAILS to load or lacks the `scenarios`
 * export throws (the caller writes it to stderr + exits 1), the same as a
 * TEMPLATE-level failure.
 *
 * `--stdin` mirrors `compile --stdin`: the (unsaved) template buffer is read into
 * a unique temp sibling of `<file>`; the scenarios file is always loaded from the
 * REAL on-disk location (independent of the buffer). `-e/--env` selects the env
 * the template compiles/runs against (default test).
 */
export async function executeScenarios(fileArg: string | undefined, opts: ExecuteOptions): Promise<ExecuteReport> {
  if (!fileArg) {
    throw new Error("Usage: tdk execute [--stdin] <path/to/template.ts> [-e <test|prod>]");
  }
  const originalPath = resolve(fileArg);
  // Scenarios live next to the REAL file on disk, regardless of --stdin.
  const scenarios = await loadScenarios(originalPath);

  if (!opts.fromStdin) {
    const template = await importTemplateInput(originalPath);
    return runScenarios(template, scenarios, opts.env);
  }

  const source = await readStdin();
  return withStdinTempFile(originalPath, source, "execute", opts.onStdinRemap ?? (() => {}), async (tmpPath) => {
    const template = await importTemplateInput(tmpPath);
    return runScenarios(template, scenarios, opts.env);
  });
}

/**
 * Compile the template ONCE up front (the same target/flags `execute` uses) so a
 * TEMPLATE-level compile error surfaces as a top-level failure — not as N
 * identical per-scenario errors, and not silently swallowed when there are zero
 * scenarios. Then run each scenario in its own try/catch and collect the lot.
 */
export async function runScenarios(template: TemplateInput, scenarios: Scenario[], env: Env): Promise<ExecuteReport> {
  const target = { env, outDir: "" } as const;
  await compileResolved(template, target, { checkEnvSafety: false });

  const results: ScenarioOutcome[] = [];
  for (const scenario of scenarios) {
    const name = scenario?.name ?? "(unnamed scenario)";
    const branches = scenario?.branches;
    // Additive inputs (parameters + step-mock flag) so the form preview can PREFILL
    // and drive the trace. Read defensively — a broken fixture (undefined) must
    // still yield a per-scenario error, not throw out of the whole run.
    const inputs = scenarioInputs(scenario);
    try {
      const result = await execute(template, scenario.fixture, { target });
      results.push({ name, branches, result, ...inputs });
    } catch (err) {
      results.push({ name, branches, error: formatError(err), ...inputs });
    }
  }
  return { ok: true, scenarios: results };
}

/** The additive form-preview inputs for a scenario (its `parameters`, step-mock flag, and mocks). */
function scenarioInputs(scenario: Scenario | undefined): ScenarioInputs {
  const fixture = scenario?.fixture as
    | { parameters?: unknown; steps?: Record<string, { output: unknown }> }
    | undefined;
  const steps = fixture?.steps;
  const hasStepMocks = Boolean(steps && Object.keys(steps).length > 0);
  return {
    parameters: fixture?.parameters,
    hasStepMocks,
    ...(hasStepMocks ? { steps } : {}),
  };
}

/**
 * Run ONE inline fixture against the template — the live-trace path the VS Code
 * form preview drives. The template source is read from disk (the inline path can't
 * ALSO pipe an unsaved buffer, since stdin already carries the fixture JSON). The
 * FIXTURE never touches the sibling scenarios file: it is the caller's current form
 * values, optionally merged over a selected scenario's step mocks. The report is
 * `{ ok: true, result }` or `{ ok: false, error }` — a run error (a step without a
 * mock or simulator) is reported honestly, never thrown, so the trace can render it.
 */
export async function executeInlineFixture(
  fileArg: string | undefined,
  fixture: InlineFixture,
  env: Env,
): Promise<InlineExecuteReport> {
  if (!fileArg) {
    throw new Error("Usage: tdk execute --fixture-stdin <path/to/template.ts> [-e <test|prod>]");
  }
  const originalPath = resolve(fileArg);
  const target = { env, outDir: "" } as const;
  const template = await importTemplateInput(originalPath);
  try {
    const result = await execute(template, fixture, { target });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }
}

/** Read ALL of stdin as text (the piped fixture JSON) — a thin re-export for the CLI. */
export function readInlineFixtureStdin(): Promise<string> {
  return readStdin();
}

/** Parse a JSON fixture read from stdin, validating it carries the required `parameters`. */
export function parseInlineFixture(json: string): InlineFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`--fixture-stdin expects a JSON fixture on stdin: ${formatError(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--fixture-stdin expects a JSON object with a `parameters` field.");
  }
  const fixture = parsed as Record<string, unknown>;
  if (typeof fixture.parameters !== "object" || fixture.parameters === null) {
    throw new Error("--fixture-stdin fixture must have an object `parameters` field.");
  }
  return fixture as unknown as InlineFixture;
}

/** Serialize an execute report to its stdout form (compact JSON + a trailing newline). */
export function serializeExecuteReport(report: ExecuteReport | InlineExecuteReport): string {
  return `${safeJson(report)}\n`;
}
