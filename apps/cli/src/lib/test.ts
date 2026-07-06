// `tdk test` — the scenario SNAPSHOT engine (the jest/vitest model). Pure: every
// function here returns structured data or a formatted STRING (never writes a
// stream, never exits). Snapshot files ARE read/written on disk (Node/Bun file
// IO is fine in lib); stdout/stderr and the process exit code are `cli.ts`'s job.
//
// The public surface `cli.ts` wires:
//   - `resolveTestTargets`  — path → { root, templates }, throwing "path not
//                             found" and flagging zero-templates (warn / --ci-fail)
//   - `listScenarios`       — the side-effect-free `--list` report (no execute, no
//                             snapshot IO)
//   - `runTests`            — run every discovered template's snapshots → reports
//   - `runTemplateTest`     — one template's snapshot reconciliation (also used by
//                             `init` to write the first baseline)
//   - `formatTestReport`    — the human-readable (non-JSON) report STRING
//   - `serializeTestReports`/`serializeListReport` — the `--json` stdout strings

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { compileResolved, type ExecuteResult, execute, type TemplateInput } from "@tdk/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { formatError } from "./errors.ts";
import { importTemplateInput, loadScenarios, type Scenario, safeJson, scenariosPathFor } from "./load.ts";

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** A scenario's snapshot outcome on a run. */
export type ScenarioStatus = "passed" | "failed" | "written" | "updated";

/** One scenario's line in a `tdk test` report. */
export interface ScenarioReport {
  name: string;
  branches?: string[];
  status: ScenarioStatus;
  /** The fresh `ExecuteResult` (present whenever `execute()` ran). */
  result?: ExecuteResult;
  /** The stored snapshot rendered to YAML — only on `failed` (for a diff). */
  expected?: string;
  /** The fresh result rendered to YAML — only on `failed` (for a diff). */
  actual?: string;
  /**
   * The error text when this scenario's `execute()` threw (no diff in that
   * case). Also mirrored into `actual` for one release, for callers still
   * reading the old overloaded field.
   */
  error?: string;
}

/** One template's `tdk test` outcome (a suite of scenarios). */
export interface TemplateReport {
  /** Path relative to the discovery root (for display + the `--json` output). */
  path: string;
  /** Did the suite load/compile? (a load or compile error fails the whole suite). */
  ok: boolean;
  /** The formatted `file:line:col` load/compile error, when `ok` is false. */
  error?: string;
  scenarios: ScenarioReport[];
  /** Snapshot entries whose scenario no longer exists (warned; pruned under -u). */
  obsolete?: string[];
}

/** One template's `--list` entry: its scenario names + branches, or a load error. */
export interface ListedTemplate {
  path: string;
  ok: boolean;
  error?: string;
  scenarios: Array<{ name: string; branches?: string[] }>;
}

/** The flags `tdk test` understands. */
export interface TestOptions {
  update: boolean;
  ci: boolean;
}

// ---------------------------------------------------------------------------
// Target resolution + discovery
// ---------------------------------------------------------------------------

/** The resolved test targets: the display `root`, and the template.ts paths to run. */
export interface TestTargets {
  /** The discovery root — a single file's dir, or the passed directory. */
  root: string;
  /** Absolute `template.ts` paths to run (sorted for a stable report). */
  templates: string[];
  /** True when nothing was discovered — the caller warns / fails under `--ci`. */
  empty: boolean;
}

/**
 * Resolve a `tdk test [path]` argument into its discovery root and the template
 * paths to run. `path` is either a DIRECTORY to glob for testable templates (a
 * dir holding BOTH `template.ts` and `__fixtures__/scenarios.ts`) or a single
 * template `.ts` FILE (the VS Code extension passes one). A nonexistent path
 * THROWS `tdk test: path not found: …` (never a raw ENOENT). Zero discovered
 * templates is flagged via `empty` — the caller decides warn (normal) vs fail
 * (`--ci`) — with the message available from `emptyMessage`.
 */
export async function resolveTestTargets(pathArg: string | undefined): Promise<TestTargets> {
  const target = resolve(pathArg ?? ".");
  const info = await stat(target).catch(() => undefined);
  if (!info) {
    throw new Error(`tdk test: path not found: ${target}`);
  }
  const isFile = info.isFile();
  // A single file runs just itself (root = its dir, so the path shows as
  // `template.ts`); a directory globs for every testable template under it.
  const root = isFile ? dirname(target) : target;
  const templates = isFile ? [target] : await discoverTestableTemplates(target);
  return { root, templates, empty: templates.length === 0 };
}

/** The loud message for a zero-templates discovery (warned normally, thrown under --ci). */
export function emptyMessage(root: string): string {
  return `no testable templates found under ${root} (a testable template is a directory holding template.ts and __fixtures__/scenarios.ts)`;
}

/**
 * Discover testable templates under `root`: every `**​/__fixtures__/scenarios.ts`
 * (via Bun's glob, excluding `node_modules`) whose sibling `../template.ts`
 * exists. Returns the absolute `template.ts` paths, sorted for a stable report.
 */
export async function discoverTestableTemplates(root: string): Promise<string[]> {
  const glob = new Bun.Glob("**/__fixtures__/scenarios.ts");
  const templates: string[] = [];
  for await (const match of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    // Split on both separators so the exclusion also holds on Windows paths.
    if (match.split(/[\\/]/).includes("node_modules")) continue;
    // <dir>/__fixtures__/scenarios.ts → <dir>/template.ts
    const templatePath = join(dirname(dirname(match)), "template.ts");
    if (await Bun.file(templatePath).exists()) templates.push(templatePath);
  }
  return templates.sort();
}

// ---------------------------------------------------------------------------
// tdk test --list (side-effect-free)
// ---------------------------------------------------------------------------

/** The overall `--list` outcome: the per-template entries + whether any failed to load. */
export interface ListResult {
  templates: ListedTemplate[];
  /** True if any listed template's scenarios file failed to load (exit code 1). */
  anyFailed: boolean;
}

/**
 * `tdk test --list`: DISCOVER the templates and their scenario names WITHOUT
 * executing anything or reading/writing snapshots. A scenarios file that fails
 * to load is reported as `ok: false` with its error (and flips `anyFailed`, so
 * the caller exits 1). The VS Code extension uses this for test discovery.
 */
export async function listScenarios(templatePaths: string[], root: string): Promise<ListResult> {
  const templates: ListedTemplate[] = [];
  let anyFailed = false;
  for (const templatePath of templatePaths) {
    const path = relative(root, templatePath);
    try {
      const scenarios = await loadScenarios(templatePath);
      templates.push({
        path,
        ok: true,
        scenarios: scenarios.map((s) => ({
          name: s?.name ?? "(unnamed scenario)",
          ...(s?.branches ? { branches: s.branches } : {}),
        })),
      });
    } catch (err) {
      anyFailed = true;
      templates.push({ path, ok: false, error: formatError(err), scenarios: [] });
    }
  }
  return { templates, anyFailed };
}

/** Serialize a `--list` result to its stdout form (compact JSON + trailing newline). */
export function serializeListReport(result: ListResult): string {
  return `${safeJson({ templates: result.templates })}\n`;
}

// ---------------------------------------------------------------------------
// tdk test — running
// ---------------------------------------------------------------------------

/** The result of a full `runTests` sweep: the reports + the elapsed millis. */
export interface RunResult {
  reports: TemplateReport[];
  ms: number;
}

/** Run each discovered template's snapshots. Returns the reports + elapsed time. */
export async function runTests(templates: string[], root: string, opts: TestOptions): Promise<RunResult> {
  const start = performance.now();
  const reports: TemplateReport[] = [];
  for (const templatePath of templates) {
    reports.push(await runTemplateTest(templatePath, root, opts));
  }
  const ms = Math.round(performance.now() - start);
  return { reports, ms };
}

/** Serialize the run reports to the `--json` stdout form (compact + trailing newline). */
export function serializeTestReports(reports: TemplateReport[]): string {
  return `${safeJson({ templates: reports })}\n`;
}

/** True if the run should exit 1: any suite failed to load, or any scenario failed. */
export function anyFailure(reports: TemplateReport[]): boolean {
  return reports.some((r) => !r.ok || r.scenarios.some((s) => s.status === "failed"));
}

/**
 * Run ONE testable template's scenario SNAPSHOTS. Loads its scenarios (a broken
 * or export-less scenarios file fails the SUITE — never a silent zero), rejects
 * duplicate scenario names (snapshots are keyed by name), and compiles the
 * template once (a template-level error → `ok: false`, every scenario marked
 * `failed` but un-run); otherwise runs each scenario through `execute()` and
 * reconciles its fresh `ExecuteResult` against the stored snapshot map in
 * `<dir>/__snapshots__/scenarios.snap` (a corrupt snapshot file also fails just
 * this suite, naming the file). Per scenario:
 *
 *   - no stored snapshot      → WRITE it, status `written` (a `failed` under --ci,
 *                               which never writes)
 *   - stored, STRUCTURALLY eq → `passed`
 *   - stored, different       → `failed`, with an expected/actual YAML diff (the
 *                               stored snapshot is PRESERVED — never overwritten
 *                               on a normal run)
 *   - `-u` / `--update`       → overwrite with the fresh result, status `updated`
 *
 * Obsolete entries (in the file but no longer a scenario) are warned and pruned
 * only under `-u`. The file is (re)written only when something changed: a new
 * `written` snapshot on a normal run, or any run under `-u`.
 */
export async function runTemplateTest(templatePath: string, root: string, opts: TestOptions): Promise<TemplateReport> {
  const path = relative(root, templatePath);

  let scenarios: Scenario[];
  try {
    scenarios = await loadScenarios(templatePath);
  } catch (err) {
    return { path, ok: false, error: formatError(err), scenarios: [] };
  }

  const names = scenarios.map((s) => ({
    name: s?.name ?? "(unnamed scenario)",
    branches: s?.branches,
  }));

  // Snapshot entries are keyed by scenario name — duplicates would silently
  // last-win on write and then stay permanently red. Reject them outright.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size) {
    const list = [...duplicates].map((d) => `"${d}"`).join(", ");
    return {
      path,
      ok: false,
      error:
        `Duplicate scenario name(s) in ${scenariosPathFor(templatePath)}: ${list}. ` +
        `Snapshots are keyed by name — every scenario needs a unique one.`,
      scenarios: names.map((n) => ({ ...n, status: "failed" as const })),
    };
  }

  let template: TemplateInput;
  try {
    template = await importTemplateInput(templatePath);
    await compileResolved(template, { env: "test", outDir: "" }, { checkEnvSafety: false });
  } catch (err) {
    return {
      path,
      ok: false,
      error: formatError(err),
      scenarios: names.map((n) => ({ ...n, status: "failed" as const })),
    };
  }

  const snapPath = snapshotPath(templatePath);
  let stored: Record<string, unknown>;
  try {
    stored = await loadSnapshots(snapPath);
  } catch (err) {
    // A corrupt snapshot file fails THIS suite (naming the file); other
    // templates in the run are unaffected.
    return {
      path,
      ok: false,
      error: formatError(err),
      scenarios: names.map((n) => ({ ...n, status: "failed" as const })),
    };
  }
  const currentNames = new Set(names.map((n) => n.name));
  const obsolete = Object.keys(stored).filter((k) => !currentNames.has(k));

  const reports: ScenarioReport[] = [];
  // The snapshot file to write, in `scenarios.ts` order (only persisted below).
  const nextEntries: Array<[string, unknown]> = [];

  for (const scenario of scenarios) {
    const name = scenario?.name ?? "(unnamed scenario)";
    const branches = scenario?.branches;

    let result: ExecuteResult;
    try {
      result = await execute(template, scenario.fixture);
    } catch (err) {
      // A per-scenario `execute()` throw (rare — the template compiled) is a
      // failure; preserve any stored snapshot so `-u` is still the only accept.
      if (Object.hasOwn(stored, name)) {
        nextEntries.push([name, stored[name]]);
      }
      const error = formatError(err);
      // `actual` mirrors `error` for one release — older callers read it there.
      reports.push({ name, branches, status: "failed", error, actual: error });
      continue;
    }

    const fresh = toComparable(result);

    if (opts.update) {
      nextEntries.push([name, fresh]);
      reports.push({ name, branches, status: "updated", result });
      continue;
    }

    const has = Object.hasOwn(stored, name);
    if (!has) {
      if (opts.ci) {
        // CI never writes; a missing snapshot is a hard failure.
        reports.push({ name, branches, status: "failed", result, expected: "", actual: stringifyYaml(fresh) });
      } else {
        nextEntries.push([name, fresh]);
        reports.push({ name, branches, status: "written", result });
      }
      continue;
    }

    // Compare STRUCTURALLY (both sides JSON-normalized) so YAML formatting never
    // causes a false diff; render YAML only to DISPLAY a mismatch.
    if (deepEqual(fresh, stored[name])) {
      nextEntries.push([name, stored[name]]);
      reports.push({ name, branches, status: "passed", result });
    } else {
      nextEntries.push([name, stored[name]]); // preserve — don't accept on a normal run
      reports.push({
        name,
        branches,
        status: "failed",
        result,
        expected: stringifyYaml(stored[name]),
        actual: stringifyYaml(fresh),
      });
    }
  }

  // Persist: under -u rewrite the whole file (obsolete pruned); on a normal run
  // rewrite only when a new snapshot was written (obsolete entries preserved).
  if (opts.update) {
    await writeSnapshots(snapPath, Object.fromEntries(nextEntries));
  } else if (reports.some((r) => r.status === "written")) {
    for (const k of obsolete) nextEntries.push([k, stored[k]]);
    await writeSnapshots(snapPath, Object.fromEntries(nextEntries));
  }

  return { path, ok: true, scenarios: reports, obsolete: obsolete.length ? obsolete : undefined };
}

// ---------------------------------------------------------------------------
// Snapshot file IO
// ---------------------------------------------------------------------------

/** Absolute path of a template's snapshot file. */
export function snapshotPath(templatePath: string): string {
  return join(dirname(templatePath), "__snapshots__", "scenarios.snap");
}

/**
 * Read the snapshot file into a `scenarioName → ExecuteResult` map. A MISSING
 * file (or empty / non-map content) is an empty map — never an error — so a
 * first run writes every snapshot. A file that EXISTS but fails to parse throws
 * a contextual error naming the file (the caller fails just that suite).
 */
export async function loadSnapshots(snapPath: string): Promise<Record<string, unknown>> {
  const file = Bun.file(snapPath);
  if (!(await file.exists())) return {};
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(
      `Corrupt snapshot file ${snapPath}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Fix or delete the file, then re-run (a deleted snapshot is rewritten on the next run).`,
    );
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** Write the `scenarioName → ExecuteResult` map to the snapshot file (as YAML). */
export async function writeSnapshots(snapPath: string, map: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(snapPath), { recursive: true });
  await writeFile(snapPath, stringifyYaml(map), "utf8");
}

/**
 * Normalize an `ExecuteResult` to a plain JSON value (via `safeJson`): drops
 * `undefined` members and coerces a stray BigInt, so a fresh result and a stored
 * snapshot (which round-tripped through YAML) compare like-for-like.
 */
export function toComparable(value: unknown): unknown {
  return JSON.parse(safeJson(value));
}

/** Structural deep-equality on JSON-shaped values (key-order independent). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

// ---------------------------------------------------------------------------
// Human-readable report (a STRING; the caller writes it)
// ---------------------------------------------------------------------------

/** Render the vitest/bun-test-style snapshot report (color only when `tty`). */
export function formatTestReport(reports: TemplateReport[], ms: number, tty: boolean): string {
  const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
  const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
  const cyan = (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
  const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

  const counts = { passed: 0, failed: 0, written: 0, updated: 0 };
  const obsoleteAll: string[] = [];
  const lines: string[] = [];

  for (const report of reports) {
    lines.push(report.ok ? report.path : red(report.path));
    for (const s of report.scenarios) {
      counts[s.status]++;
      if (s.status === "passed") {
        lines.push(`  ${green("✓")} ${s.name}`);
      } else if (s.status === "written") {
        lines.push(`  ${green("+")} ${s.name} ${dim("(written)")}`);
      } else if (s.status === "updated") {
        lines.push(`  ${cyan("↻")} ${s.name} ${dim("(updated)")}`);
      } else {
        lines.push(`  ${red("✗")} ${s.name}`);
        if (s.error !== undefined) {
          // The scenario's execute() threw — show the error, there is no diff.
          for (const ln of s.error.split("\n")) lines.push(`    ${red(ln)}`);
        } else if (s.expected !== undefined || s.actual !== undefined) {
          // A snapshot mismatch shows an expected/received YAML diff.
          lines.push(`    ${dim("Expected:")}`);
          for (const ln of (s.expected ?? "").trimEnd().split("\n")) lines.push(`    ${green(`- ${ln}`)}`);
          lines.push(`    ${dim("Received:")}`);
          for (const ln of (s.actual ?? "").trimEnd().split("\n")) lines.push(`    ${red(`+ ${ln}`)}`);
        }
      }
    }
    // A template-level load/compile error is shown ONCE under the header.
    if (!report.ok && report.error) {
      for (const errLine of report.error.split("\n")) lines.push(`    ${red(errLine)}`);
    }
    if (report.obsolete?.length) {
      obsoleteAll.push(...report.obsolete.map((o) => `${report.path} → ${o}`));
    }
    lines.push("");
  }

  const segments: string[] = [];
  if (counts.passed) segments.push(green(`${counts.passed} passed`));
  if (counts.failed) segments.push(red(`${counts.failed} failed`));
  if (counts.written) segments.push(green(`${counts.written} written`));
  if (counts.updated) segments.push(cyan(`${counts.updated} updated`));
  const total = counts.passed + counts.failed + counts.written + counts.updated;
  segments.push(dim(`(${total} scenarios across ${reports.length} templates)`));
  lines.push(segments.join(dim(" · ")));

  if (obsoleteAll.length) {
    lines.push(yellow(`⚠ ${obsoleteAll.length} obsolete snapshot(s) (run with -u to prune):`));
    for (const o of obsoleteAll) lines.push(yellow(`    ${o}`));
  }

  const templatesFailed = reports.filter((r) => !r.ok).length;
  lines.push(dim(`Done in ${ms}ms`));
  lines.push(
    counts.failed === 0 && templatesFailed === 0
      ? green(`✓ ${total} scenario(s) ok.`)
      : red(
          `✗ ${counts.failed} scenario(s) failed` +
            (templatesFailed ? `, ${templatesFailed} template suite(s) failed to load` : "") +
            ".",
        ),
  );
  return `${lines.join("\n")}\n`;
}
