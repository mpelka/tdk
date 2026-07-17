// Compile engine.
//
// `compile(template, target)` compiles a Template definition into a Backstage
// Scaffolder Template entity for one deploy target:
//   - resolves every `env.pick` to the target env's value,
//   - renders `raw` expressions / param refs to strings,
//   - builds the JSON-Schema parameter form (with `required`),
//   - applies lifecycle (emits `restrictedToUsers` while state !== "ga"),
//   - returns `{ object, yaml }`.
//
// It also runs the ENV-SAFETY check on every artifact: no string in an artifact
// compiled for env E may equal a known `env.pick` value that is EXCLUSIVE to a
// different env.

import { stringify } from "yaml";
import { exclusiveValuesByEnv, isEnvPick } from "./env.ts";
import type { RefResolver } from "./expr/index.ts";
import { isRawExpr, isRawRef } from "./expr/index.ts";
import type { JsonataExpr } from "./expr/jsonata/index.ts";
import { isJsonataExpr } from "./expr/jsonata/index.ts";
import type { PageObject } from "./pages.ts";
import { applyRequiredErrorMessages, buildPage } from "./pages.ts";
import { ParamBase, requireParam } from "./params.ts";
import type { ResolvedMap } from "./resolve.ts";
import { isResolvable, lookupResolved, resolveMarkers } from "./resolve.ts";
import type { Target, TemplateInput } from "./targets.ts";
import type { BuiltForm, InputValue, Step, Template } from "./template.ts";

const API_VERSION = "scaffolder.backstage.io/v1beta3";
const KIND = "Template";

/** A compiled Backstage Template entity (plain JSON object). */
export interface TemplateEntity {
  apiVersion: typeof API_VERSION;
  kind: typeof KIND;
  metadata: {
    name: string;
    title: string;
    description?: string;
    tags?: string[];
  };
  spec: {
    type: string;
    owner?: string;
    restrictedToUsers?: string[];
    /** A single JSON-Schema form, or an ordered array of form pages. */
    parameters: JsonSchemaObject | PageObject[];
    steps: CompileStep[];
    output?: Record<string, unknown>;
    /** Extra top-level spec keys from `Template.extraSpec`. */
    [key: string]: unknown;
  };
}

export interface JsonSchemaObject {
  required?: string[];
  properties: Record<string, unknown>;
  /** ajv-errors messages — the lifted `required` map lands here (issue #59). */
  errorMessage?: unknown;
}

interface CompileStep {
  id?: string;
  name?: string;
  action: string;
  input?: Record<string, unknown>;
  if?: string | boolean;
}

export interface CompileResult {
  /** The Template entity as a plain object. */
  object: TemplateEntity;
  /** The same entity serialized to YAML. */
  yaml: string;
}

/**
 * Internal resolution context. A `RefResolver` (so `RawRef.render`, which only
 * reads `.env`, stays compatible) plus the optional resolved-marker cache the
 * async pre-pass fills in. Carried through `resolveValue`/`resolveStep`.
 */
type CompileResolver = RefResolver & { resolved?: ResolvedMap };

/**
 * Compile one Template for one target.
 *
 * @param input  A Template instance or class.
 * @param target The deploy target (env + outDir).
 * @param opts   `{ checkEnvSafety, resolved, form }` — `checkEnvSafety` defaults
 *               to true for every env; `resolved` is the marker cache produced by
 *               `compileResolved`/`compileAll` (sync callers leave it unset);
 *               `form` is the built form returned by `Template.prepare` (the
 *               async paths pass it so load()-dependent forms stay per-call
 *               values — sync callers leave it unset and get the static form).
 */
export function compile(
  input: TemplateInput,
  target: Target,
  opts: { checkEnvSafety?: boolean; resolved?: ResolvedMap; form?: BuiltForm } = {},
): CompileResult {
  const tpl = input;
  let form = opts.form;
  if (!form) {
    if (tpl.requiresPreparation) {
      throw new Error(
        `Template "${tpl.id}" declares load(); compile it via compileResolved / compileAll / ` +
          `execute (which run load() first), not the synchronous compile().`,
      );
    }
    // Param names are bound where the form is built (builtForm / prepare), so
    // no separate bindParamNames pass is needed here.
    form = tpl.builtForm();
  }

  assertUniqueStepIds(tpl.id, form.steps);

  const resolver: CompileResolver = { env: target.env, resolved: opts.resolved };

  const entity: TemplateEntity = {
    apiVersion: API_VERSION,
    kind: KIND,
    metadata: {
      name: tpl.id,
      title: tpl.title,
      ...(tpl.description !== undefined ? { description: tpl.description } : {}),
      ...(tpl.tags?.length ? { tags: tpl.tags } : {}),
    },
    spec: {
      type: tpl.type,
      ...(tpl.owner !== undefined ? { owner: tpl.owner } : {}),
      ...buildRestriction(tpl),
      ...checkedExtraSpec(tpl),
      parameters: buildParameters(form),
      steps: form.steps.map((step) => resolveStep(step, resolver)),
      ...(form.output ? { output: resolveRecord(form.output, resolver) } : {}),
    },
  };

  assertNoUnresolvedMarkers(entity);
  if (opts.checkEnvSafety !== false) {
    assertNoCrossEnvLeaks(entity, target.env);
  }

  // lineWidth: 0 disables line wrapping so `${{ ... }}` expressions stay intact.
  return { object: entity, yaml: stringify(entity, { lineWidth: 0 }) };
}

/**
 * Lifecycle → `restrictedToUsers` under spec, only while state !== "ga".
 * FAILS CLOSED: a non-ga state with an empty/missing user list used to compile
 * UNRESTRICTED (visible to everyone) — now it throws.
 */
function buildRestriction(tpl: Template): { restrictedToUsers?: string[] } {
  const lc = tpl.lifecycle;
  if (!lc || lc.state === "ga") return {};
  const users = lc.restrictedToUsers ?? [];
  if (users.length === 0) {
    throw new Error(
      `Template "${tpl.id}": lifecycle state "${lc.state}" requires a non-empty restrictedToUsers — ` +
        `a non-ga template must name who may run it, else it would compile UNRESTRICTED. ` +
        `Add lifecycle.restrictedToUsers, or set state: "ga" to release it to everyone.`,
    );
  }
  return { restrictedToUsers: users };
}

/**
 * The spec keys compile models itself, mapped to where to set them. `extraSpec`
 * used to silently OVERRIDE type/owner/restrictedToUsers and be silently
 * overridden by parameters/steps/output — now any collision throws.
 */
const MODELED_SPEC_KEYS: Record<string, string> = {
  type: "Template.type",
  owner: "Template.owner",
  restrictedToUsers: "Template.lifecycle.restrictedToUsers",
  parameters: "Template.params / Template.pages (or defineTemplate `parameters`)",
  steps: "build() (or defineTemplate `steps`)",
  output: "Template.output",
};

/** Validate + return `extraSpec` for spreading into the compiled spec. */
function checkedExtraSpec(tpl: Template): Record<string, unknown> {
  if (!tpl.extraSpec) return {};
  const gated = Boolean(tpl.lifecycle && tpl.lifecycle.state !== "ga");
  for (const key of Object.keys(tpl.extraSpec)) {
    const modeled = MODELED_SPEC_KEYS[key];
    if (!modeled) continue;
    // Without a lifecycle gate, compile does not emit restrictedToUsers itself,
    // so extraSpec may legitimately supply it verbatim.
    if (key === "restrictedToUsers" && !gated) continue;
    throw new Error(
      `Template "${tpl.id}": extraSpec key "${key}" collides with a spec field TDK models — ` +
        `set ${modeled} instead. extraSpec is only for keys TDK does not model.`,
    );
  }
  return tpl.extraSpec;
}

/**
 * Build `spec.parameters`. A `pages` array (when present) becomes the ordered
 * array of form pages; otherwise the flat `params` map becomes a single page.
 * Parameter names must be unique ACROSS pages (they share one namespace in the
 * Scaffolder form) — a duplicate throws.
 */
function buildParameters(form: BuiltForm): JsonSchemaObject | PageObject[] {
  if (form.pages?.length) {
    const seen = new Map<string, string>();
    for (const pg of form.pages) {
      for (const name of Object.keys(pg.properties)) {
        const prior = seen.get(name);
        if (prior !== undefined) {
          throw new Error(
            `duplicate parameter name "${name}" — declared on page "${prior}" and again on page ` +
              `"${pg.title}". Parameter names share one namespace across pages; rename one of them.`,
          );
        }
        seen.set(name, pg.title);
      }
    }
    return form.pages.map(buildPage);
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const requiredMessages: Record<string, string> = {};
  for (const [name, value] of Object.entries(form.params)) {
    const param = requireParam(name, value);
    properties[name] = param.toSchema();
    if (param.required) {
      required.push(name);
      // The flat form has no required-list override, so the param's own flag is
      // final — lift its authored required message here (the parent object),
      // exactly like the page path (verifier finding on #67).
      if (param.requiredErrorMessage !== undefined) requiredMessages[name] = param.requiredErrorMessage;
    }
  }
  const out: JsonSchemaObject = { properties };
  if (required.length) out.required = required;
  applyRequiredErrorMessages(out, requiredMessages);
  return out;
}

/** Throw on duplicate step ids — `execute()` keys step outputs by id, so a
 * duplicate would silently overwrite the earlier step's result. */
function assertUniqueStepIds(tplId: string, steps: Step[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.id === undefined) continue;
    if (seen.has(step.id)) {
      throw new Error(
        `Template "${tplId}": duplicate step id "${step.id}" — step ids must be unique ` +
          `(step outputs are keyed by id, so the earlier step's output would be lost).`,
      );
    }
    seen.add(step.id);
  }
}

function resolveStep(step: Step, resolver: CompileResolver): CompileStep {
  const out: CompileStep = { action: step.action };
  if (step.id !== undefined) out.id = step.id;
  if (step.name !== undefined) out.name = step.name;
  const where = `step "${step.id ?? step.action}"`;
  if (step.input !== undefined) {
    out.input = resolveRecord(step.input, resolver, `${where} input`) as Record<string, unknown>;
  }
  if (step.if !== undefined) {
    // `if` is resolved exactly like an input value (refs render, env.pick and
    // resolver markers resolve) — `collectMarkerRoots` includes it for the
    // same reason.
    out.if = resolveValue(step.if, resolver, `${where} \`if\``) as CompileStep["if"];
  }
  return out;
}

function resolveRecord(
  record: Record<string, InputValue>,
  resolver: CompileResolver,
  where = "output",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = resolveValue(value, resolver, `${where}.${key}`);
  }
  return out;
}

/**
 * Resolve any authored value to its compiled form:
 *   - resolver marker → its async-resolved concrete value (which then flows
 *     through env-safety like any literal),
 *   - env.pick → the target env's value (kept as its native type),
 *   - param ref / nj() → a Scaffolder `${{ … }}` expression string,
 *   - arrays/objects → resolved recursively,
 *   - literals → unchanged.
 *
 * `where` names the value's location (`step "x" input.body`, `output.greeting`)
 * so a rejection can point straight at it. A `JsonataExpr` (`jsonata(...)` or
 * `raw.jsonata`) reaching HERE is rejected — see `rejectJsonataInInterpolation`.
 */
function resolveValue(value: unknown, resolver: CompileResolver, where = "value"): unknown {
  if (value instanceof ParamBase) {
    // Object.entries below would degrade the instance into a plain object the
    // marker walk can't see — catch the mistake here, by name.
    const name = value.boundName === undefined ? "" : ` "${value.boundName}"`;
    throw new Error(
      `compile: a Param${name} was used directly as a value — did you mean its .ref ` +
        `(which interpolates \${{ parameters.<name> }})?`,
    );
  }
  // SILENT→LOUD: a JsonataExpr used as an interpolated VALUE renders `${{ <jsonata> }}`,
  // but Backstage's `${{ }}` is Nunjucks and cannot evaluate JSONata — the artifact
  // would be wrong-by-construction. Must precede isRawRef (a JsonataExpr is one).
  if (isJsonataExpr(value)) rejectJsonataInInterpolation(value, where);
  if (isResolvable(value)) {
    return lookupResolved(value, resolver.env, resolver.resolved);
  }
  // The picked branch flows back through `resolveValue` itself (not returned
  // verbatim) so a branch OBJECT/ARRAY containing markers (raw/nj()/jsonata()/
  // param refs) renders exactly like any other input subtree — an env.pick is
  // just a values-differ-per-env wrapper, not an escape from resolution.
  // A branch that is itself another env.pick recurses through this same `if`
  // on the next call and resolves too (deliberate: a picked branch is "any
  // other value" per the doc comment above, and nesting picks per env is a
  // reasonable authoring pattern) — resolved against the SAME target env, so
  // it can only narrow/rename the outer pick's branches, never re-branch on a
  // different axis.
  if (isEnvPick(value)) return resolveValue(value.resolve(resolver.env), resolver, where);
  if (isRawExpr(value)) return value.render(resolver);
  if (isRawRef(value)) return value.render(resolver);
  if (Array.isArray(value)) {
    return value.map((v, i) => resolveValue(v, resolver, `${where}[${i}]`));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, resolver, `${where}.${k}`);
    }
    return out;
  }
  return value;
}

/**
 * SILENT→LOUD rejection for a `JsonataExpr` used as a `${{ … }}` interpolation
 * value (step input, step `if`, or output). Backstage evaluates `${{ }}` with
 * Nunjucks, which cannot parse JSONata, so such an artifact is wrong-by-
 * construction (and `execute`'s Nunjucks renderer throws on it too). Point at
 * the two correct homes: `.jsonata` into a roadie `expression:` field, or `nj()`
 * for a `${{ }}` interpolation. `never` — this always throws.
 */
function rejectJsonataInInterpolation(expr: JsonataExpr, where: string): never {
  throw new Error(
    `compile: a jsonata(...) expression was used at ${where} — this renders \${{ <jsonata> }}, ` +
      `but Backstage's \${{ }} is Nunjucks and cannot evaluate JSONata, so the compiled YAML ` +
      `would be wrong-by-construction. Put the JSONata where it belongs:\n` +
      `  - feed its string into a roadiehq:utils:jsonata step's \`expression:\` field ` +
      `(e.g. \`expression: <expr>.jsonata\`), or\n` +
      `  - use nj(...) instead if you meant a \${{ }} Nunjucks interpolation.\n` +
      `  jsonata: ${expr.jsonata}`,
  );
}

/**
 * Classify a value that must never survive into a compiled artifact. Returns a
 * human-readable kind, or null for ordinary values. Detects live DSL objects
 * (Param / env.pick / raw / refs / resolver markers) and clone-degraded ones
 * (a `structuredClone`d marker keeps its `__tdk*` data properties).
 */
function markerKind(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  if (value instanceof ParamBase) return "a Param instance";
  if (isResolvable(value)) return `an unresolved resolver marker ("${value.resolver}")`;
  if (isEnvPick(value)) return "an env.pick(...) marker";
  if (isRawExpr(value)) return "an unrendered raw`...` expression";
  if (isRawRef(value)) return "an unrendered ref/expression";
  for (const key of Object.keys(value)) {
    if (key.startsWith("__tdk")) return `a TDK marker ("${key}")`;
  }
  return null;
}

/**
 * SILENT→LOUD: no TDK marker may survive into the compiled entity. Values that
 * compile does not resolve — `extraSpec` and parameter schemas (defaults,
 * ui:options, …) are emitted VERBATIM — used to serialize a stray marker as
 * `{ values: …, __tdkEnvPick: true }` garbage. Walk the whole built entity and
 * throw, naming the JSON path.
 */
function assertNoUnresolvedMarkers(entity: TemplateEntity): void {
  walkObjects(entity, (value, path) => {
    const kind = markerKind(value);
    if (kind) {
      throw new Error(
        `compile: template "${entity.metadata.name}" has ${kind} at ${path} — this location is ` +
          `emitted verbatim, so the marker would serialize as garbage. Markers are only resolved ` +
          `in step inputs, step \`if\`, and output; use a plain literal here.`,
      );
    }
  });
}

function walkObjects(value: unknown, visit: (v: unknown, path: string) => void, path = "$"): void {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkObjects(v, visit, `${path}[${i}]`);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkObjects(v, visit, `${path}.${k}`);
    }
  }
}

/**
 * ENV-SAFETY: the enforced "an artifact for env E cannot reference another env"
 * guarantee, generalized to any number of envs.
 *
 * `env.pick` already prevents accidental leaks (an env's artifact gets that
 * env's values). This catches the OTHER failure mode: a value EXCLUSIVE to some
 * other env, hardcoded as a literal somewhere in this env's artifact. A value
 * shared across envs (or supplied via `default`) is not exclusive and is fine.
 * Scans every string in the entity for a value exclusive to any env ≠ `env`.
 */
export function assertNoCrossEnvLeaks(entity: TemplateEntity, env: string): void {
  const byEnv = exclusiveValuesByEnv();
  // Every exclusive value that belongs to a DIFFERENT env than this artifact's,
  // mapped back to that owning env for a pointed message.
  const foreign = new Map<string, string>();
  for (const [ownerEnv, values] of byEnv) {
    if (ownerEnv === env) continue;
    for (const v of values) if (!foreign.has(v)) foreign.set(v, ownerEnv);
  }
  if (foreign.size === 0) return;
  const hits: string[] = [];
  walkStrings(entity, (s, path) => {
    const ownerEnv = foreign.get(s);
    if (ownerEnv !== undefined) hits.push(`${path} = ${JSON.stringify(s)} (exclusive to env "${ownerEnv}")`);
  });
  if (hits.length) {
    throw new Error(
      `env-safety: "${env}" artifact "${entity.metadata.name}" contains value(s) exclusive to another env:\n` +
        hits.map((h) => `  - ${h}`).join("\n") +
        `\nA value exclusive to another env must never appear in this env's artifact. ` +
        `Use env.pick(...) instead of hardcoding the other env's value.`,
    );
  }
}

function walkStrings(value: unknown, visit: (s: string, path: string) => void, path = "$"): void {
  if (typeof value === "string") {
    visit(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walkStrings(v, visit, `${path}[${i}]`);
    });
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(v, visit, `${path}.${k}`);
    }
  }
}

/**
 * The authored values that may contain resolver markers: every step's `input`
 * and `if`, plus `output`. Matches `resolveValue`'s domain (NOT `extraSpec`,
 * which compile rejects markers in). Reads the built form, so the steps are
 * built exactly once per compile. Fed to `resolveMarkers` by the async paths.
 */
function collectMarkerRoots(form: BuiltForm): unknown[] {
  const roots: unknown[] = [];
  for (const step of form.steps) {
    if (step.input !== undefined) roots.push(step.input);
    if (step.if !== undefined) roots.push(step.if);
  }
  if (form.output) roots.push(form.output);
  return roots;
}

/**
 * Compile one Template for one target, resolving any deferred markers first.
 *
 * The async counterpart to `compile`: it runs load()/prepare for the target
 * env (getting the built form as a value), runs the marker resolution pre-pass
 * (awaiting every registered resolver), and hands both to the synchronous
 * `compile`. Use this (or `compileAll`) whenever a template may contain
 * resolver markers; plain `compile` cannot run async resolvers.
 */
export async function compileResolved(
  input: TemplateInput,
  target: Target,
  opts: { checkEnvSafety?: boolean; loaded?: unknown } = {},
): Promise<CompileResult> {
  const tpl = input;
  // Run load() for this env first (static form without load()); `opts.loaded`,
  // when set, injects the data and skips load() (the fixture-tier mock). The
  // form is a per-call VALUE, so concurrent compiles for different targets
  // can never observe each other's prepared state.
  const form = await tpl.prepare({ env: target.env }, { loaded: opts.loaded });
  const roots = collectMarkerRoots(form);
  const resolved = await resolveMarkers(roots, { env: target.env });
  return compile(tpl, target, { checkEnvSafety: opts.checkEnvSafety, resolved, form });
}

/** A compile job: one template against one named target. */
export interface CompileJob {
  templateId: string;
  targetName: string;
  outPath: string;
  result: CompileResult;
}

/**
 * Compile every template × target and write each to its output path — either
 * `target.out(tpl)` (full path, any layout) or, by default, the nested
 * `<target.outDir>/<template.id>/template.yaml`. Returns the jobs (with paths
 * and results) so callers can log or assert.
 */
export async function compileAll(
  templates: TemplateInput[],
  targets: Record<string, Target>,
  opts: { write?: boolean } = {},
): Promise<CompileJob[]> {
  if (Object.keys(targets).length === 0) {
    throw new Error(`compileAll: "targets" needs at least one entry (a named { env, outDir | out } target).`);
  }
  const { join, dirname } = await import("node:path");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const jobs: CompileJob[] = [];
  for (const input of templates) {
    const tpl = input;
    for (const [targetName, target] of Object.entries(targets)) {
      // compileResolved prepares per target (load() is env-aware, so a load()
      // template bakes different options into each env) and resolves markers
      // per target env, building the form as a per-call value.
      const result = await compileResolved(tpl, target);
      // `out(tpl)` gives the full path (any layout); otherwise the nested default.
      let outPath: string;
      if (target.out) {
        outPath = target.out({ id: tpl.id, title: tpl.title, type: tpl.type });
      } else if (target.outDir !== undefined) {
        outPath = join(target.outDir, tpl.id, "template.yaml");
      } else {
        throw new Error(`compileAll: target "${targetName}" must set either "outDir" or "out"`);
      }
      if (opts.write !== false) {
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(outPath, result.yaml, "utf8");
      }
      jobs.push({
        templateId: tpl.id,
        targetName,
        outPath,
        result,
      });
    }
  }
  return jobs;
}
