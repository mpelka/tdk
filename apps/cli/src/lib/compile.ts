// The compile operations: single-file `compile` and whole-config `build`. Pure
// in the sense that matters here — they never write to stdout/stderr and never
// exit; they return data (a YAML string, a list of build jobs) or write to DISK
// (a `-o` file, the build output tree — Node/Bun file IO is fine in lib), and
// throw typed errors on failure. `cli.ts` owns the streams, the progress lines,
// and the exit code.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertValid, compileResolved, type Target, type TdkConfig, type TemplateInput } from "@tdk/core";
import { importTemplateInput, readStdin, type StdinRemap, withStdinTempFile } from "./load.ts";

/** A compile/run env from a `-e/--env` flag — any env name (default "test"). */
export type Env = string;

// ---------------------------------------------------------------------------
// tdk compile — single file
// ---------------------------------------------------------------------------

/** Options for the single-file compile operation. */
export interface CompileOptions {
  /** `--stdin`: read the (unsaved) template source from stdin. */
  fromStdin: boolean;
  /** `-o/--out`: write to this path instead of returning YAML for stdout. */
  out: string | undefined;
  /** `-e/--env`: which env to compile for (default test). */
  env: Env;
  /** Backstage schema validation (default on; `--no-validate` turns it off). */
  validate: boolean;
  /**
   * Called with `{ from: tmpPath, to: originalPath }` when a `--stdin` compile
   * routes through a temp file, so the caller can rewrite the temp path back to
   * the original in any error that escapes. Ignored for the on-disk path.
   */
  onStdinRemap?: (remap: StdinRemap) => void;
}

/** The outcome of a single-file compile: YAML for stdout, or `written` for `-o`. */
export type CompileOutcome = { kind: "yaml"; yaml: string } | { kind: "written"; path: string };

/**
 * Compile a single template, validate it against the Backstage schema (unless
 * `--no-validate`), and either RETURN its YAML (for the caller to print) or,
 * with `-o`, WRITE it to that path (creating parent dirs) and return `written`.
 * Without `--stdin` the file on disk is compiled. With `--stdin` the source is
 * read from stdin (the editor's UNSAVED buffer) and compiled via a unique temp
 * sibling of `<file>` — so relative imports and `@tdk/core` resolve exactly as
 * for the real file, and Bun's module cache never returns stale content. Any
 * failure throws to the caller (which writes it to stderr + exits 1).
 */
export async function compileTemplate(fileArg: string | undefined, opts: CompileOptions): Promise<CompileOutcome> {
  if (!fileArg) {
    throw new Error("Usage: tdk compile [--stdin] <path/to/template.ts> [-o <path>] [-e <env>] [--no-validate]");
  }
  const originalPath = resolve(fileArg);

  const emit = async (yaml: string): Promise<CompileOutcome> => {
    if (opts.out) {
      const outPath = resolve(opts.out);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, yaml, "utf8");
      return { kind: "written", path: outPath };
    }
    return { kind: "yaml", yaml };
  };

  if (!opts.fromStdin) {
    return emit(await compileFileToYaml(originalPath, opts.env, opts.validate));
  }

  const source = await readStdin();
  return withStdinTempFile(originalPath, source, "compile", opts.onStdinRemap ?? (() => {}), async (tmpPath) =>
    emit(await compileFileToYaml(tmpPath, opts.env, opts.validate)),
  );
}

/**
 * Import a template module, find the Template it exports, compile it to YAML,
 * and (by default) validate the compiled entity against the Backstage schema.
 */
export async function compileFileToYaml(importPath: string, env: Env, validate: boolean): Promise<string> {
  const template = await importTemplateInput(importPath);
  // Compile the found template (resolving any deferred resolver markers first)
  // against the requested env, with env-safety ON: a literal in this artifact
  // that is EXCLUSIVE to a different env (per the process-wide env.pick registry)
  // is a leak regardless of which env we compiled for.
  const { yaml, object } = await compileResolved(template, { env, outDir: "" }, { checkEnvSafety: true });
  if (validate) await assertValid(object);
  return yaml;
}

// ---------------------------------------------------------------------------
// tdk build — whole config
// ---------------------------------------------------------------------------

/** The template fields a target's `out(...)` path function receives. */
type TargetMeta = Parameters<NonNullable<Target["out"]>>[0];

/** One compiled + validated artifact, ready to write or print. */
export interface BuildJob {
  templateId: string;
  targetName: string;
  outPath: string;
  yaml: string;
}

/**
 * Anchor a target's output paths to the config file's directory: `outDir` and
 * the result of `out(meta)` are documented as "relative to the config file",
 * so resolve them against it (not against whatever cwd `tdk build` ran from).
 */
function anchorTarget(target: Target, configDir: string): Target {
  const out = target.out;
  return {
    ...target,
    ...(target.outDir !== undefined ? { outDir: resolve(configDir, target.outDir) } : {}),
    ...(out ? { out: (meta: TargetMeta) => resolve(configDir, out(meta)) } : {}),
  };
}

/** The output path for one template × target (mirrors core's layout rules). */
function outPathFor(target: Target, template: TemplateInput, targetName: string): string {
  if (target.out) {
    return target.out({ id: template.id, title: template.title, type: template.type });
  }
  if (target.outDir !== undefined) {
    return join(target.outDir, template.id, "template.yaml");
  }
  throw new Error(`tdk build: target "${targetName}" must set either "outDir" or "out".`);
}

/**
 * Load the config and compile + VALIDATE every template × target BEFORE anything
 * touches disk — so an invalid artifact never leaves a half-written output tree.
 * Returns the ready-to-persist jobs (nothing is written or printed here). Output
 * paths resolve relative to the CONFIG FILE, not the cwd. Throws if the config
 * is missing its `templates`/`targets`, or on any compile/validation failure.
 */
export async function buildConfig(configArg: string | undefined): Promise<BuildJob[]> {
  const configPath = resolve(configArg ?? "tdk.config.ts");
  const configDir = dirname(configPath);
  const mod = (await import(configPath)) as { default: TdkConfig };
  const config = mod.default;
  if (!config?.templates || !config?.targets) {
    throw new Error(`Config at ${configPath} must default-export defineConfig({ templates, targets }).`);
  }

  // Compile + validate everything BEFORE any write/print.
  const jobs: BuildJob[] = [];
  for (const template of config.templates) {
    for (const [targetName, target] of Object.entries(config.targets)) {
      const anchored = anchorTarget(target, configDir);
      const outPath = outPathFor(anchored, template, targetName);
      const result = await compileResolved(template, anchored);
      await assertValid(result.object);
      jobs.push({ templateId: template.id, targetName, outPath, yaml: result.yaml });
    }
  }
  return jobs;
}

/**
 * Render the build jobs as a single stdout string: each artifact's YAML,
 * separated by a `---` document marker, with a trailing newline. Used by
 * `build --stdout` — nothing touches disk.
 */
export function buildStdout(jobs: BuildJob[]): string {
  return `${jobs.map((job) => job.yaml.replace(/\n$/, "")).join("\n---\n")}\n`;
}

/**
 * Write one build job's YAML to its resolved output path (creating parent dirs).
 * Returns nothing; the caller prints the per-artifact progress line.
 */
export async function writeBuildJob(job: BuildJob): Promise<void> {
  await mkdir(dirname(job.outPath), { recursive: true });
  await writeFile(job.outPath, job.yaml, "utf8");
}
