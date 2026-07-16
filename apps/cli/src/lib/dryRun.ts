// `tdk dry-run` — batch-dry-run a sweep of templates (.ts and .yaml) against a live
// Backstage and report each outcome. Pure in the way the other lib ops are: it returns a
// structured report (and serializers for it); `cli.ts` owns stdout/stderr and the exit
// code. The network client and its env config come from `@tdk/core/backstage`; the .ts
// compile and .yaml read come from `@tdk/core` (`compileResolved` / `fromYaml`).
//
// The command is deliberately SAFE: it only ever calls `dryRun` (no side effects), never
// `createTask`. It exists so a CI job or a coding-agent loop can validate that a batch of
// templates still dry-runs green against a real backend, with values sourced honestly:
//
//   - a .ts template: compile for `--env`, then take values from the named scenario's
//     fixture (`--scenario`, default the first scenario when a `__fixtures__/scenarios.ts`
//     sits beside it), or from `--values`, or synthesized (`--synthesize-values`).
//   - a .yaml template: read via `fromYaml`, then take values from `--values`, else a
//     COLOCATED `<basename>.values.json` sibling, else synthesized.
//
// `--values` (an explicit file) always wins. Every synthesized run is flagged in the
// report so a reader never mistakes a placeholder pass for a real one.

import { resolve } from "node:path";
import { compileResolved, fromYaml, type TemplateInput } from "@tdk/core";
import { type BackstageClient, backstageClient, type DryRunResult } from "@tdk/core/backstage";
import { Glob } from "bun";
import type { Env } from "./compile.ts";
import { formatError } from "./errors.ts";
import { importTemplateInput, loadScenarios, safeJson } from "./load.ts";

/** The colocated values convention for a `.yaml` template: a `<basename>.values.json` sibling. */
export function colocatedValuesPath(yamlPath: string): string {
  return yamlPath.replace(/\.ya?ml$/i, ".values.json");
}

/** Where a template's dry-run values came from — surfaced so a report is never ambiguous. */
export type ValuesSource = "values-file" | "colocated" | "scenario" | "synthesized";

/** Options for one dry-run sweep — the flags `tdk dry-run` exposes, resolved. */
export interface DryRunSweepOptions {
  /** `-e/--env`: the env a `.ts` template compiles for (default test). Ignored for `.yaml`. */
  env: Env;
  /** `--scenario`: pick this scenario's fixture for a `.ts` template (default: the first). */
  scenario?: string;
  /** `--values`: an explicit JSON values file that wins over every other source. */
  valuesFile?: string;
  /** `--synthesize-values`: derive minimal values from the schema when no other source has them. */
  synthesizeValues: boolean;
  /** `--concurrency`: how many dry-runs run at once (default 4). */
  concurrency: number;
  /** `--timeout`: per-request timeout in ms (forwarded to the client). */
  timeoutMs?: number;
  /** `--base-url`: override the base URL (else `TDK_BACKSTAGE_URL`). No token flag — env only. */
  baseUrl?: string;
  /**
   * The client to use. Defaults to a real `backstageClient` from the base URL + env token.
   * Injectable so unit tests drive the sweep with a fake client (no live Backstage).
   */
  client?: BackstageClient;
}

/** One template's line in the sweep report. */
export interface TemplateReport {
  /** The path swept (as given / globbed, resolved to absolute). */
  path: string;
  /** `.ts` or `.yaml` — how the artifact was produced. */
  source: "ts" | "yaml";
  /**
   * The outcome kind. Either a pre-flight failure (`notTemplate`, `parseError`,
   * `loadError`, `compileError`, `valuesError`) that never contacted Backstage, or the
   * dry-run taxonomy (`ok`, `validationFailed`, `authFailed`, `serverError`, `unreachable`).
   */
  kind: "notTemplate" | "parseError" | "loadError" | "compileError" | "valuesError" | DryRunResult["kind"];
  /** True only for `kind: "ok"`. */
  ok: boolean;
  /** The values source, when a dry-run was attempted. */
  valuesSource?: ValuesSource;
  /** True when the values were synthesized (a placeholder run — never a real pass). */
  synthesized: boolean;
  /** The HTTP status, for the arms that carry one (`authFailed`, `serverError`). */
  status?: number;
  /** A human message for any non-ok outcome. */
  message?: string;
  /** Wall-clock ms for the dry-run request (0 when no request was made). */
  durationMs: number;
}

/** The whole sweep's report. `ok` is true only when EVERY template dry-ran `ok`. */
export interface DryRunSweepReport {
  ok: boolean;
  templates: TemplateReport[];
}

/**
 * Expand the path arguments (each a literal path or a glob) into a sorted, de-duplicated
 * list of `.ts`/`.yaml` files. A literal path is kept as-is; a glob is scanned relative to
 * the cwd. Non-`.ts`/`.yaml` matches are dropped (a `**` sweep should not try to dry-run a
 * README). Throws when an argument matches nothing, so a typo never silently sweeps zero.
 */
export async function expandPaths(paths: string[], cwd: string = process.cwd()): Promise<string[]> {
  const out = new Set<string>();
  for (const arg of paths) {
    if (isGlob(arg)) {
      let matched = 0;
      for await (const rel of new Glob(arg).scan({ cwd, onlyFiles: true })) {
        if (isTemplateFile(rel)) {
          out.add(resolve(cwd, rel));
          matched++;
        }
      }
      if (matched === 0) throw new Error(`No .ts or .yaml templates matched the pattern "${arg}".`);
    } else {
      if (!isTemplateFile(arg)) throw new Error(`Not a .ts or .yaml template: "${arg}".`);
      out.add(resolve(cwd, arg));
    }
  }
  return [...out].sort();
}

/** Whether a string looks like a glob pattern (contains `*`, `?`, `[`, or a brace group). */
function isGlob(arg: string): boolean {
  return /[*?[\]{}]/.test(arg);
}

/** Whether a path is a `.ts` or `.yaml`/`.yml` template file. */
function isTemplateFile(path: string): boolean {
  return /\.ts$/i.test(path) || /\.ya?ml$/i.test(path);
}

/**
 * Derive a MINIMAL values payload from a compiled `spec.parameters` schema — property
 * `default` first, then the first `enum` member, then a type-appropriate placeholder — for
 * REQUIRED base fields ONLY (dependency-revealed fields are left out; a minimal run should
 * not guess at a conditional branch). BAILS (throws) on a required field it cannot satisfy
 * honestly — a required object with no default, or a typeless required field — rather than
 * invent a deep structure. Returns the values object on success.
 */
export function synthesizeValues(parameters: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const unsatisfiable: string[] = [];

  for (const schema of asSchemaObjects(parameters)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const name of required) {
      if (name in values) continue; // already satisfied by an earlier page
      const prop = properties[name];
      const value = placeholderFor(prop);
      if (value === UNSATISFIABLE) unsatisfiable.push(name);
      else values[name] = value;
    }
  }

  if (unsatisfiable.length > 0) {
    throw new Error(
      `Cannot synthesize values for required field(s): ${unsatisfiable.join(", ")}. ` +
        "Provide --values (a JSON file) or a colocated values file for this template — " +
        "the synthesizer refuses to invent object trees or typeless fields.",
    );
  }
  return values;
}

/** The sentinel a property returns when no honest placeholder exists (bail on it). */
const UNSATISFIABLE = Symbol("unsatisfiable");

/** A single required property's placeholder — default → first enum → type placeholder → bail. */
function placeholderFor(prop: unknown): unknown {
  if (!isRecord(prop)) return UNSATISFIABLE;
  if ("default" in prop) return prop.default;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  switch (prop.type) {
    case "string":
      return "example";
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return false;
    case "array":
      return [];
    // A required object with no default is exactly the "don't invent a deep structure"
    // case; a typeless required field is equally unsatisfiable.
    default:
      return UNSATISFIABLE;
  }
}

/** Normalize `spec.parameters` (a single schema OR an array of pages) to a list of schema objects. */
function asSchemaObjects(parameters: unknown): Array<{ required?: unknown; properties?: unknown }> {
  if (Array.isArray(parameters))
    return parameters.filter(isRecord) as Array<{ required?: unknown; properties?: unknown }>;
  if (isRecord(parameters)) return [parameters as { required?: unknown; properties?: unknown }];
  return [];
}

/** A plain-object type guard (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read + parse a JSON values file, throwing a clear error on a missing file or bad JSON. */
async function readValuesFile(path: string): Promise<Record<string, unknown>> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Values file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    throw new Error(`Values file ${path} is not valid JSON: ${formatError(err)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Values file ${path} must contain a JSON object of parameter values.`);
  return parsed;
}

/** The resolved artifact for one path, plus its parameters schema (for the synthesizer). */
interface ResolvedArtifact {
  object: object;
  yaml: string;
  parameters: unknown;
}

/**
 * Produce one path's compiled artifact + parameters schema: `.ts` compiles for `env`
 * (env-safety on), `.yaml` reads via `fromYaml`. Returns a discriminated result so the
 * caller renders a pre-flight failure (`compileError`/`loadError`/`parseError`/
 * `notTemplate`) without ever contacting Backstage.
 */
async function resolveArtifact(
  path: string,
  env: Env,
): Promise<
  | { kind: "ok"; source: "ts" | "yaml"; artifact: ResolvedArtifact; template?: TemplateInput }
  | { kind: "loadError" | "compileError" | "parseError" | "notTemplate"; source: "ts" | "yaml"; message: string }
> {
  if (/\.ts$/i.test(path)) {
    let template: TemplateInput;
    try {
      template = await importTemplateInput(path);
    } catch (err) {
      return { kind: "loadError", source: "ts", message: formatError(err) };
    }
    try {
      const { object, yaml } = await compileResolved(template, { env, outDir: "" }, { checkEnvSafety: true });
      return {
        kind: "ok",
        source: "ts",
        template,
        artifact: { object, yaml, parameters: (object.spec as { parameters?: unknown }).parameters },
      };
    } catch (err) {
      return { kind: "compileError", source: "ts", message: formatError(err) };
    }
  }

  // A .yaml source.
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (err) {
    return { kind: "loadError", source: "yaml", message: formatError(err) };
  }
  const detected = fromYaml(text);
  if (detected.kind === "parseError") {
    const where = detected.line !== undefined ? `${path}:${detected.line}: ` : "";
    return { kind: "parseError", source: "yaml", message: `${where}${detected.message}` };
  }
  if (detected.kind === "notTemplate") {
    return { kind: "notTemplate", source: "yaml", message: detected.reason };
  }
  const parameters = (detected.object as { spec?: { parameters?: unknown } }).spec?.parameters;
  return { kind: "ok", source: "yaml", artifact: { object: detected.object, yaml: detected.yaml, parameters } };
}

/** The values for one dry-run, plus which source they came from — or an error to report. */
type ValuesResolution =
  | { kind: "ok"; values: Record<string, unknown>; source: ValuesSource }
  | { kind: "error"; message: string };

/**
 * Resolve the values for one template by the documented priority. `.ts`: `--values` >
 * the named/first scenario's fixture > synthesized. `.yaml`: `--values` > a colocated
 * `<basename>.values.json` > synthesized. When no source applies, returns an error naming
 * every way to supply values — never a silent empty payload.
 */
async function resolveValues(
  path: string,
  source: "ts" | "yaml",
  parameters: unknown,
  opts: DryRunSweepOptions,
): Promise<ValuesResolution> {
  // 1. An explicit --values file always wins.
  if (opts.valuesFile) {
    try {
      return { kind: "ok", values: await readValuesFile(resolve(opts.valuesFile)), source: "values-file" };
    } catch (err) {
      return { kind: "error", message: formatError(err) };
    }
  }

  // 2. The source-specific middle tier: a scenario fixture (.ts) or a colocated file (.yaml).
  if (source === "ts") {
    const scenarios = await loadScenarios(path);
    if (scenarios.length > 0) {
      const chosen = opts.scenario ? scenarios.find((s) => s.name === opts.scenario) : scenarios[0];
      if (!chosen) {
        const names = scenarios.map((s) => s.name ?? "(unnamed)").join(", ");
        return { kind: "error", message: `No scenario named "${opts.scenario}". Available: ${names}.` };
      }
      const values = (chosen.fixture as { parameters?: unknown }).parameters;
      if (isRecord(values)) return { kind: "ok", values, source: "scenario" };
    } else if (opts.scenario) {
      return {
        kind: "error",
        message: `--scenario "${opts.scenario}" given, but no __fixtures__/scenarios.ts beside ${path}.`,
      };
    }
  } else {
    const colocated = colocatedValuesPath(path);
    if (await Bun.file(colocated).exists()) {
      try {
        return { kind: "ok", values: await readValuesFile(colocated), source: "colocated" };
      } catch (err) {
        return { kind: "error", message: formatError(err) };
      }
    }
  }

  // 3. Synthesize, only when asked.
  if (opts.synthesizeValues) {
    try {
      return { kind: "ok", values: synthesizeValues(parameters), source: "synthesized" };
    } catch (err) {
      return { kind: "error", message: formatError(err) };
    }
  }

  const hint =
    source === "ts"
      ? "add a __fixtures__/scenarios.ts, pass --values <file.json>, or pass --synthesize-values"
      : `add a colocated ${colocatedValuesPath(path).split("/").pop()}, pass --values <file.json>, or pass --synthesize-values`;
  return { kind: "error", message: `No values for the dry-run: ${hint}.` };
}

/** Whether a dry-run result is worth a polite retry (a 429 or any 5xx). */
function isRetryable(result: DryRunResult): boolean {
  return result.kind === "serverError" && (result.status === 429 || result.status >= 500);
}

/** Sleep for `ms` (used for the backoff between retries). */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** How many times a retryable (429/5xx) dry-run is re-attempted, and the base backoff. */
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 250;

/**
 * Dry-run ONE resolved artifact, with a polite sequential backoff on 429/5xx: on a
 * retryable result it waits (250ms, 500ms, 1000ms) and re-attempts, up to `MAX_RETRIES`,
 * so a rate-limited or briefly-overloaded backend is not reported as a hard failure on the
 * first blip. Any other outcome returns immediately.
 */
async function dryRunWithBackoff(
  client: BackstageClient,
  artifact: { object: object; yaml: string },
  values: Record<string, unknown>,
): Promise<DryRunResult> {
  let result = await client.dryRun(artifact, { values });
  for (let attempt = 1; attempt <= MAX_RETRIES && isRetryable(result); attempt++) {
    await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    result = await client.dryRun(artifact, { values });
  }
  return result;
}

/** Dry-run one path end-to-end (resolve artifact → resolve values → request) into a report row. */
async function runOne(path: string, opts: DryRunSweepOptions, client: BackstageClient): Promise<TemplateReport> {
  const resolved = await resolveArtifact(path, opts.env);
  if (resolved.kind !== "ok") {
    return {
      path,
      source: resolved.source,
      kind: resolved.kind,
      ok: false,
      synthesized: false,
      durationMs: 0,
      message: resolved.message,
    };
  }

  const valuesResult = await resolveValues(path, resolved.source, resolved.artifact.parameters, opts);
  if (valuesResult.kind === "error") {
    return {
      path,
      source: resolved.source,
      kind: "valuesError",
      ok: false,
      synthesized: false,
      durationMs: 0,
      message: valuesResult.message,
    };
  }

  const startedAt = Date.now();
  const result = await dryRunWithBackoff(client, resolved.artifact, valuesResult.values);
  const durationMs = Date.now() - startedAt;

  return {
    path,
    source: resolved.source,
    kind: result.kind,
    ok: result.kind === "ok",
    valuesSource: valuesResult.source,
    synthesized: valuesResult.source === "synthesized",
    durationMs,
    ...(result.kind === "ok" ? {} : { message: messageOf(result) }),
    ...("status" in result ? { status: result.status } : {}),
  };
}

/** The human message for a non-ok dry-run result. */
function messageOf(result: DryRunResult): string {
  switch (result.kind) {
    case "validationFailed":
      return `validation failed: ${result.errors.map((e) => e.message).join("; ")}`;
    case "authFailed":
    case "serverError":
    case "unreachable":
      return result.message;
    default:
      return "";
  }
}

/**
 * Run a bounded worker pool of at most `concurrency` dry-runs at a time over `paths`,
 * preserving input order in the report. The pool is the concurrency CAP; the per-request
 * backoff (429/5xx) handles politeness within it.
 */
async function runPool(paths: string[], opts: DryRunSweepOptions, client: BackstageClient): Promise<TemplateReport[]> {
  const reports: TemplateReport[] = new Array(paths.length);
  const limit = Math.max(1, opts.concurrency);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= paths.length) return;
      reports[i] = await runOne(paths[i]!, opts, client);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, paths.length) }, worker));
  return reports;
}

/**
 * Run a whole dry-run sweep and return its report. Builds the client from `--base-url` +
 * `TDK_BACKSTAGE_TOKEN` (unless one was injected for tests), sweeps every path through the
 * bounded pool, and reports `ok` only when EVERY template dry-ran `ok`.
 */
export async function runDryRunSweep(paths: string[], opts: DryRunSweepOptions): Promise<DryRunSweepReport> {
  const client = opts.client ?? backstageClient({ baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
  const reports = await runPool(paths, opts, client);
  return { ok: reports.every((r) => r.ok), templates: reports };
}

/** Serialize a sweep report to its `--json` stdout form (compact JSON + a trailing newline). */
export function serializeDryRunReport(report: DryRunSweepReport): string {
  return `${safeJson(report)}\n`;
}

/**
 * Render a sweep report as human-readable lines: one status line per template (with its
 * values source, a synthesized flag, duration, and any message) plus a final summary. TTY
 * is passed so a caller can decide on color later (kept plain for now — matches the other
 * CLI reporters).
 */
export function formatDryRunReport(report: DryRunSweepReport, relTo: string = process.cwd()): string {
  const lines: string[] = [];
  for (const t of report.templates) {
    const mark = t.ok ? "✓" : "✗";
    const rel = relPath(t.path, relTo);
    const src = t.valuesSource ? ` [${t.valuesSource}${t.synthesized ? " — SYNTHESIZED" : ""}]` : "";
    const status = t.status !== undefined ? ` ${t.status}` : "";
    const timing = t.durationMs > 0 ? ` (${t.durationMs}ms)` : "";
    lines.push(`${mark} ${rel} → ${t.kind}${status}${src}${timing}`);
    if (!t.ok && t.message) lines.push(`    ${t.message}`);
  }
  const okCount = report.templates.filter((t) => t.ok).length;
  const total = report.templates.length;
  lines.push("");
  lines.push(`${okCount}/${total} template(s) dry-ran ok.`);
  return `${lines.join("\n")}\n`;
}

/** A cwd-relative path for display, falling back to the absolute path when outside cwd. */
function relPath(path: string, relTo: string): string {
  return path.startsWith(`${relTo}/`) ? path.slice(relTo.length + 1) : path;
}
