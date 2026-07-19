// `tdk migrate` — turn one or more migration models into template directories
// (ADR-0026, phase c). Pure in the lib sense: every function returns structured data
// or writes to DISK (Node/Bun file IO is fine here); it never writes a stream and
// never exits. `cli.ts` owns stdout/stderr and the process exit code.
//
// The flow per model:
//   gate 0  — validateModel (schema + semantic). `--validate-only` stops here.
//   emit    — printTemplate into <out>/<template-id>/ (refuse to overwrite unless
//             --force; generate-once is the model).
//   smoke   — import the emitted template and run compile + validate (gate-1-lite),
//             reported but not fatal (a mapped template needs the org's pack to
//             import — an expected, honest miss).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertValid, compileResolved, type TemplateInput } from "@tdk/core";
import {
  type MigrationMapping,
  type MigrationModel,
  type MigrationReport,
  type ModelError,
  printTemplate,
  validateModel,
} from "@tdk/core/migrate";
import { formatError } from "./errors.ts";

/** The options `tdk migrate` understands. */
export interface MigrateOptions {
  /** `--out`: the directory to write template dirs into (default `.`). */
  out: string;
  /** `--mapping`: a JSON (or .ts/.js default-export) action/lookup mapping file. */
  mapping?: string;
  /** `--validate-only`: run gate 0 alone, write nothing. */
  validateOnly: boolean;
  /** `--force`: overwrite an existing output directory. */
  force: boolean;
}

/** The smoke (gate-1-lite) outcome for one emitted template. */
export interface SmokeResult {
  ok: boolean;
  /** The compile/validate error, when the smoke did not pass. */
  error?: string;
}

/** One model's migrate outcome. */
export interface MigrateModelResult {
  /** The model file path (resolved). */
  modelPath: string;
  /** The template id (present once the model parsed + validated). */
  templateId?: string;
  /** Did gate 0 pass? */
  valid: boolean;
  /** The gate-0 errors (empty when valid). */
  errors: ModelError[];
  /** The output directory the files were written into. */
  outDir?: string;
  /** The written file paths, in write order. */
  files?: string[];
  /** The migration report (also written to disk). */
  report?: MigrationReport;
  /** The compile+validate smoke result. */
  smoke?: SmokeResult;
  /** A read/parse/emission error that stopped this model. */
  error?: string;
}

/** The whole sweep's outcome. */
export interface MigrateResult {
  models: MigrateModelResult[];
  /** True when every model validated and (unless `--validate-only`) emitted ok. */
  ok: boolean;
}

/** Load and parse the org-supplied mapping (`.json` parsed; `.ts`/`.js` imported). */
export async function loadMapping(path: string): Promise<MigrationMapping> {
  const resolved = resolve(path);
  if (resolved.endsWith(".json")) {
    return JSON.parse(await readFile(resolved, "utf8")) as MigrationMapping;
  }
  const mod = (await import(resolved)) as { default?: MigrationMapping };
  if (!mod.default) {
    throw new Error(`Mapping file ${resolved} must default-export the mapping object.`);
  }
  return mod.default;
}

/** Read + JSON-parse one model file. Throws a contextual error on a parse failure. */
async function loadModel(path: string): Promise<MigrationModel> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as MigrationModel;
  } catch (err) {
    throw new Error(`${path}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run the emitted template through compile + validate as a smoke. Imports the
 * written `template.ts`, resolving any deferred markers, and schema-validates the
 * artifact. A failure (often a mapped template's not-yet-present pack import) is
 * REPORTED, not fatal.
 */
async function smokeTest(templatePath: string): Promise<SmokeResult> {
  try {
    // A cache-buster so a re-run in the same process re-reads the fresh file.
    const mod = (await import(`${templatePath}?t=${Date.now()}`)) as { default?: TemplateInput };
    const template = mod.default;
    if (!template) return { ok: false, error: "the emitted template has no default export" };
    const { object } = await compileResolved(template, { env: "test", outDir: "" }, { checkEnvSafety: false });
    await assertValid(object);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }
}

/** Migrate ONE model file. Never throws for an expected failure — encodes it. */
export async function migrateOne(
  modelPath: string,
  opts: MigrateOptions,
  mapping: MigrationMapping | undefined,
): Promise<MigrateModelResult> {
  const resolved = resolve(modelPath);

  let model: MigrationModel;
  try {
    model = await loadModel(resolved);
  } catch (err) {
    return { modelPath: resolved, valid: false, errors: [], error: formatError(err) };
  }

  const validation = validateModel(model);
  if (!validation.valid) {
    return { modelPath: resolved, templateId: model?.template?.id, valid: false, errors: validation.errors };
  }

  const templateId = model.template.id;
  if (opts.validateOnly) {
    return { modelPath: resolved, templateId, valid: true, errors: [] };
  }

  // Emit into <out>/<template-id>/, refusing to overwrite unless --force.
  const outDir = join(resolve(opts.out), templateId);
  if (!opts.force && (await Bun.file(join(outDir, "template.ts")).exists())) {
    return {
      modelPath: resolved,
      templateId,
      valid: true,
      errors: [],
      error: `refusing to overwrite ${join(outDir, "template.ts")} (generate-once) — pass --force to regenerate.`,
    };
  }

  let printed: ReturnType<typeof printTemplate>;
  try {
    printed = printTemplate(model, { mapping });
  } catch (err) {
    return { modelPath: resolved, templateId, valid: true, errors: [], error: formatError(err) };
  }

  const written: string[] = [];
  try {
    for (const [rel, content] of Object.entries(printed.files)) {
      const path = join(outDir, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      written.push(path);
    }
  } catch (err) {
    return { modelPath: resolved, templateId, valid: true, errors: [], error: formatError(err) };
  }

  const smoke = await smokeTest(join(outDir, "template.ts"));

  return {
    modelPath: resolved,
    templateId,
    valid: true,
    errors: [],
    outDir,
    files: written,
    report: printed.report,
    smoke,
  };
}

/** Migrate every model file. Loads the mapping once (shared across models). */
export async function runMigrate(modelPaths: string[], opts: MigrateOptions): Promise<MigrateResult> {
  let mapping: MigrationMapping | undefined;
  if (opts.mapping) mapping = await loadMapping(opts.mapping);

  const models: MigrateModelResult[] = [];
  for (const path of modelPaths) {
    models.push(await migrateOne(path, opts, mapping));
  }
  const ok = models.every((m) => m.valid && !m.error);
  return { models, ok };
}

// ---------------------------------------------------------------------------
// Formatting (STRINGS the caller writes).
// ---------------------------------------------------------------------------

/** Format one model's gate-0 errors as `path: message` lines. */
export function formatModelReportErrors(result: MigrateModelResult): string {
  return result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}

/** The human-readable summary for a whole migrate sweep (a STRING; caller writes). */
export function formatMigrateReport(result: MigrateResult, validateOnly: boolean): string {
  const lines: string[] = [];
  for (const m of result.models) {
    if (!m.valid) {
      lines.push(`✗ ${m.modelPath}${m.templateId ? ` (${m.templateId})` : ""} — invalid model:`);
      if (m.error) lines.push(`    ${m.error}`);
      for (const e of m.errors) lines.push(`    ${e.path}: ${e.message}`);
      continue;
    }
    if (m.error) {
      lines.push(`✗ ${m.templateId} — ${m.error}`);
      continue;
    }
    if (validateOnly) {
      lines.push(`✓ ${m.modelPath} (${m.templateId}) — valid`);
      continue;
    }
    const r = m.report;
    lines.push(`✓ ${m.templateId} → ${m.outDir}`);
    for (const f of m.files ?? []) lines.push(`    + ${f}`);
    if (r) {
      lines.push(`    translated: ${r.counts.translated}, flagged: ${r.counts.flagged}`);
      for (const f of r.flagged) lines.push(`    ⚑ ${f.construct} '${f.name}': ${f.reason} (${f.path})`);
    }
    if (m.smoke) {
      lines.push(m.smoke.ok ? `    ✓ compile smoke passed` : `    ⚠ compile smoke: ${m.smoke.error?.split("\n")[0]}`);
    }
  }
  lines.push("");
  lines.push(result.ok ? `✓ ${result.models.length} model(s) migrated.` : `✗ one or more models failed.`);
  return `${lines.join("\n")}\n`;
}

/** The machine-readable (`--json`) report string (compact + trailing newline). */
export function serializeMigrateReport(result: MigrateResult): string {
  const models = result.models.map((m) => ({
    modelPath: m.modelPath,
    templateId: m.templateId,
    valid: m.valid,
    errors: m.errors,
    error: m.error,
    outDir: m.outDir,
    files: m.files,
    counts: m.report?.counts,
    flagged: m.report?.flagged,
    smoke: m.smoke,
  }));
  return `${JSON.stringify({ ok: result.ok, models })}\n`;
}
