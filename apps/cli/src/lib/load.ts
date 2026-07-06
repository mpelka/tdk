// Module loading + the small serialization helpers the CLI shares. Pure: these
// import template / scenario modules from disk, pick the Template out of a
// module's exports, and (for `--stdin`) manage the temp-file lifecycle a piped
// buffer needs — but they never write to stdout/stderr or exit. Errors are
// thrown (formatted by callers via `errors.ts`); streams + exit codes are
// `cli.ts`'s job.

import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ExecuteFixture, Template, type TemplateInput } from "@tdk/core";
import { formatError } from "./errors.ts";

/** One scenario from a `__fixtures__/scenarios.ts` (`branches` is optional metadata). */
export interface Scenario {
  name?: string;
  branches?: string[];
  fixture: ExecuteFixture;
}

/**
 * Import a template module and return the Template it exports, via
 * `findTemplate`. Throws a "No template found" error when none is present, so
 * it propagates as a template-level failure (stderr + exit 1).
 */
export async function importTemplateInput(importPath: string): Promise<TemplateInput> {
  const mod = (await import(importPath)) as Record<string, unknown>;
  const found = findTemplate(mod);
  if (!found) {
    throw new Error(
      `No template found in ${importPath}. Export a defineTemplate(...) value ` +
        `(as the default export or a named export).`,
    );
  }
  return found;
}

/**
 * Pick the template to compile from a module's exports: prefer the `default`
 * export, then the named exports in declaration order. The first export that is
 * a Template instance (the value `defineTemplate(...)` returns) wins.
 */
export function findTemplate(mod: Record<string, unknown>): TemplateInput | undefined {
  const candidates: unknown[] = [
    mod.default,
    ...Object.entries(mod)
      .filter(([name]) => name !== "default")
      .map(([, value]) => value),
  ];
  for (const value of candidates) {
    if (value instanceof Template) return value;
  }
  return undefined;
}

/** Absolute path of a template's scenarios fixture file. */
export function scenariosPathFor(templatePath: string): string {
  return join(dirname(templatePath), "__fixtures__", "scenarios.ts");
}

/**
 * Load the `scenarios` array from `<dir(templatePath)>/__fixtures__/scenarios.ts`.
 * A MISSING file is ZERO scenarios — a template with no fixtures (or a
 * not-yet-written one) still previews cleanly — but a file that FAILS TO LOAD
 * (syntax error, bad import) or that lacks a `scenarios` array export THROWS,
 * naming the file: a broken fixture must never read as "0 scenarios ok".
 */
export async function loadScenarios(templatePath: string): Promise<Scenario[]> {
  const scenariosPath = scenariosPathFor(templatePath);
  if (!(await Bun.file(scenariosPath).exists())) return [];
  let mod: Record<string, unknown>;
  try {
    mod = (await import(scenariosPath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load ${scenariosPath}:\n${formatError(err)}`);
  }
  if (!Array.isArray(mod.scenarios)) {
    const hint = "scenario" in mod ? ' (found an export named "scenario" — did you mean "scenarios"?)' : "";
    throw new Error(`${scenariosPath} does not export a \`scenarios\` array${hint}.`);
  }
  return mod.scenarios as Scenario[];
}

/**
 * Read all of stdin as UTF-8 text (the piped, possibly-unsaved buffer).
 * `Bun.stdin` reads fd 0 directly — unlike iterating `process.stdin`, it
 * cannot miss data when the pipe was written-and-closed before this code
 * attaches (observed on Linux CI: a late attach yielded an EMPTY read, so a
 * broken piped buffer compiled as an empty module → "No template found").
 */
export async function readStdin(): Promise<string> {
  return await Bun.stdin.text();
}

/**
 * `JSON.stringify` that won't throw on a non-serializable value that slips into a
 * scenario's MOCKED outputs: functions/symbols are dropped (the default
 * behaviour, made explicit) and a BigInt — which would otherwise THROW — is
 * coerced to a string. `execute`'s computed values are already plain JSON; this
 * only hardens the user-supplied fixture mocks.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    return v;
  });
}

/** A remap of `from` → `to` for rewriting a temp path back to the original in an error. */
export interface StdinRemap {
  from: string;
  to: string;
}

/**
 * Run `fn` against a UNIQUE temp sibling of `originalPath` holding `source` (a
 * piped, possibly-unsaved buffer). The temp file is written before `fn` and
 * always removed after; `fn` receives the temp path (so relative imports and
 * `@tdk/core` resolve exactly as for the real file, and Bun's module cache never
 * returns stale content — each path is imported once).
 *
 * `onRemap` is called with `{ from: tmpPath, to: originalPath }` BEFORE `fn`
 * runs, so a caller can rewrite any temp path back to the original in an error
 * that escapes. `tag` names the temp file (`compile` vs `execute`) purely for a
 * legible scratch filename.
 */
export async function withStdinTempFile<T>(
  originalPath: string,
  source: string,
  tag: string,
  onRemap: (remap: StdinRemap) => void,
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const tmpPath = join(dirname(originalPath), `.tdk-${tag}-${process.pid}-${Date.now()}.ts`);
  onRemap({ from: tmpPath, to: originalPath });
  await writeFile(tmpPath, source, "utf8");
  try {
    return await fn(tmpPath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
