// Scenario simulator — `execute(template, fixture)`.
//
// Given a TDK template + a scenario fixture (concrete parameters/secrets/user +
// MOCKED outputs for steps TDK can't actually run), this renders the
// compiled template's `${{ … }}` interpolations and runs the PURE steps to
// produce output — mirroring a hand "input values → compile yaml/jsonata/
// nunjucks → output" trace. It is the runtime counterpart to `compile`: compile
// emits the artifact, execute simulates one run of it.
//
// Fidelity notes (matching how the Backstage Scaffolder evaluates a template):
//   - Nunjucks is rendered with autoescape OFF.
//   - A field that is a SINGLE full `${{ … }}` expression preserves its native
//     type (object/array/number/boolean), not just a string — Backstage's
//     "single expression" behaviour. We recover the value via the `dump` filter
//     + `JSON.parse`. A field with embedded `${{ … }}` among other text is
//     string-interpolated.
//   - `roadiehq:utils:jsonata` is computed FOR REAL: its `data` is rendered,
//     then `jsonata(expression).evaluate(data)` → `{ result }` (roadie's shape).
//   - every other action's output is an explicit fixture mock when one is given
//     (specific beats general — see the getActionSimulator branch), else a
//     registered action simulator, else undefined.
//   - a step's `if` (a `${{ }}` boolean) is evaluated; a falsy result skips it.

import jsonataLib from "jsonata";
import nunjucks from "nunjucks";
import { parse as parseYaml } from "yaml";
import { getActionSimulator } from "./actions.ts";
import { compileResolved } from "./compile.ts";
import type { Target, TemplateInput } from "./targets.ts";
import { validateParameters } from "./validate.ts";

/** Autoescape OFF — Backstage renders Scaffolder templates this way. */
const njEnv = new nunjucks.Environment(undefined, { autoescape: false });

/** The minimal compiled shape `execute` runs against (template OR gold). */
interface ExecSpec {
  steps?: Array<{
    id?: string;
    action: string;
    input?: Record<string, unknown>;
    if?: string | boolean;
  }>;
  output?: Record<string, unknown>;
}

/**
 * A scenario fixture: concrete inputs for one run. `steps` provides MOCKED
 * outputs for steps `execute` can't actually run (http/provisioning/etc.); jsonata
 * steps are computed for real and don't need an entry. `P` lets callers type
 * `parameters` against the template's params.
 */
export interface ExecuteFixture<P = Record<string, unknown>> {
  parameters: P;
  secrets?: Record<string, unknown>;
  user?: Record<string, unknown>;
  steps?: Record<string, { output: unknown }>;
  /**
   * Pre-loaded `load()` data (the fixture-tier mock). When set, the template's
   * `load()` is NOT called and this is used to build the form — so a scenario can
   * pin the live data without any network. Omit it to let `load()` run (e.g. with
   * MSW faking the network). No effect on templates without a `load()`.
   */
  loaded?: unknown;
}

/** The simulated outcome of one step. */
export interface ExecuteStepResult {
  /** True when the step's `if` was falsy (the step did not run). */
  skipped?: boolean;
  /**
   * True when an earlier step ended with an `error` and HALTED the run before
   * this step could execute. Real Backstage stops the task at the first failed
   * step; the steps after it never run and never render their input — this flag
   * marks them so the UI can show a "not reached" rail state. Distinct from
   * `skipped` (a falsy `if:`, which does NOT halt).
   */
  notReached?: boolean;
  /** The step's `input` with every `${{ … }}` resolved. */
  input: unknown;
  /** Computed (jsonata) or mocked output; `undefined` when absent/skipped. */
  output: unknown;
  /** Set when a jsonata step's expression threw (e.g. an `$assert` guard). */
  error?: string;
}

/** The simulated outcome of one template run. */
export interface ExecuteResult {
  steps: Record<string, ExecuteStepResult>;
  output: unknown;
}

/** The evaluation context, mirroring the Scaffolder roots. */
interface Ctx {
  parameters: Record<string, unknown>;
  secrets: Record<string, unknown>;
  user: Record<string, unknown>;
  steps: Record<string, { output: unknown }>;
}

/**
 * Match a string that is exactly ONE `${{ … }}` block (modulo surrounding
 * whitespace). Returns the inner expression, or null. A non-greedy inner +
 * end-anchor rejects multi-block strings like `${{ a }}-${{ b }}`.
 */
function fullExpr(s: string): string | null {
  const m = s.match(/^\s*\$\{\{([\s\S]*?)\}\}\s*$/);
  if (!m) return null;
  if (m[1]!.includes("${{")) return null;
  return m[1]!;
}

/**
 * Evaluate a single `${{ }}` expression to its NATIVE value (object/array/
 * number/boolean/string), via the `dump` filter + `JSON.parse`. Undefined /
 * unparseable results collapse to `undefined`, matching a missing lookup.
 */
function rawEval(inner: string, ctx: Ctx): unknown {
  const json = njEnv.renderString(`{{ ( ${inner} ) | dump }}`, ctx as object);
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** String-interpolate every `${{ … }}` in `s` to a string. */
function renderToString(s: string, ctx: Ctx): string {
  return njEnv.renderString(s.replaceAll("${{", "{{"), ctx as object);
}

/** Resolve any input value: single-expr → native, embedded → string, recurse. */
function renderValue(v: unknown, ctx: Ctx): unknown {
  if (typeof v === "string") {
    const inner = fullExpr(v);
    if (inner !== null) return rawEval(inner, ctx);
    if (v.includes("${{")) return renderToString(v, ctx);
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => renderValue(x, ctx));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = renderValue(val, ctx);
    }
    return out;
  }
  return v;
}

/**
 * Evaluate a step's `if`. Absent → run. A full `${{ … }}` expression is
 * evaluated to its NATIVE value and tested with Backstage's own `isTruthy`
 * (`isArray(v) ? v.length > 0 : !!v`) — so `${{ 0 }}` skips and a param
 * holding the STRING "false" runs, exactly like the real Scaffolder. Only a
 * string with EMBEDDED interpolations falls back to the string heuristic.
 */
function evalIf(cond: string | boolean | undefined, ctx: Ctx): boolean {
  if (cond === undefined) return true;
  if (typeof cond === "boolean") return cond;
  const inner = fullExpr(cond);
  if (inner !== null) {
    const value = rawEval(inner, ctx);
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  }
  const rendered = renderToString(cond, ctx).trim();
  return rendered !== "" && rendered !== "false" && rendered !== "undefined" && rendered !== "null";
}

/** Run the engine over a compiled spec (steps + output) for one fixture. */
async function executeSpec<P>(spec: ExecSpec, fixture: ExecuteFixture<P>, env: Target["env"]): Promise<ExecuteResult> {
  const ctx: Ctx = {
    parameters: (fixture.parameters as Record<string, unknown>) ?? {},
    secrets: fixture.secrets ?? {},
    user: fixture.user ?? {},
    steps: {},
  };
  const steps: Record<string, ExecuteStepResult> = {};

  // HALT-ON-ERROR: real Backstage stops the task at the first failed step —
  // later steps never run and the task produces no output. Once `halted` is set
  // we still walk the remaining steps (so every step appears in `steps`, in
  // order, for the UI's left rail) but mark each `notReached` without rendering
  // its input: rendering against a dead context is misleading and could itself
  // throw. Only an `error` halts; a `skipped` step (falsy `if:`) does not.
  let halted = false;

  let i = 0;
  for (const step of spec.steps ?? []) {
    const id = step.id ?? `__step_${i}`;
    i++;

    if (halted) {
      steps[id] = { notReached: true, input: undefined, output: undefined };
      ctx.steps[id] = { output: undefined };
      continue;
    }

    // BELT: evaluating `if` or rendering the input must never crash the whole
    // run. A `${{ }}` holding non-Nunjucks (e.g. a stray JSONata expression —
    // compile now rejects these, see compile.ts `rejectJsonataInInterpolation`,
    // so this only bites a hand-built artifact) makes the Nunjucks renderer
    // throw; surface it as this step's `error` (parity with the roadie
    // `expression:` path below) instead of letting it escape uncaught. Like the
    // roadie path, an `error` here HALTS the run.
    let input: Record<string, unknown>;
    try {
      if (!evalIf(step.if, ctx)) {
        steps[id] = {
          skipped: true,
          input: renderValue(step.input ?? {}, ctx),
          output: undefined,
        };
        ctx.steps[id] = { output: undefined };
        continue;
      }
      input = renderValue(step.input ?? {}, ctx) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
      steps[id] = { input: step.input ?? {}, output: undefined, error: message };
      ctx.steps[id] = { output: undefined };
      halted = true;
      continue;
    }
    let output: unknown;
    let error: string | undefined;

    if (step.action === "roadiehq:utils:jsonata") {
      const expression = String(input.expression ?? "");
      try {
        output = { result: await jsonataLib(expression).evaluate(input.data) };
      } catch (err) {
        error = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
        output = undefined;
      }
    } else {
      // Non-pure action (http/provisioning/…). MOCK-WINS: an explicit fixture
      // mock for this step (`fixture.steps[id].output`) is the author's intent
      // for THIS scenario — specific beats general — so it takes precedence.
      // Only when no mock is supplied does a registered action SIMULATOR compute
      // the output from the rendered input + context (the general model of how
      // the action behaves). An explicit mock is the only way to test edge/error
      // shapes a simulator can't produce, and it makes a scenario deterministic
      // regardless of what's in the process-wide simulator registry.
      const mock = fixture.steps?.[id];
      if (mock) {
        output = mock.output;
      } else {
        const sim = getActionSimulator(step.action);
        // PARITY: a registered simulator computing a step's output is just as
        // capable of throwing as the roadie jsonata evaluate() above or the
        // BELT input-render try/catch below it — and a broken simulator is
        // this step's failure, not a crash of the whole harness. Same
        // treatment: record the thrown message as the step's `error` and halt.
        if (sim) {
          try {
            output = await sim(input, {
              stepId: id,
              env,
              parameters: ctx.parameters,
              secrets: ctx.secrets,
              user: ctx.user,
              steps: ctx.steps,
            });
          } catch (err) {
            error = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
            output = undefined;
          }
        } else {
          output = undefined;
        }
      }
    }

    steps[id] = error ? { input, output, error } : { input, output };
    ctx.steps[id] = { output };
    // An `error` (e.g. a jsonata `$assert` guard) halts the run: the remaining
    // steps are marked `notReached` on the next iterations, and the template
    // `output` is not evaluated below.
    if (error) halted = true;
  }

  return {
    steps,
    // A failed Backstage task has NO output — when the run halted on an error we
    // do not evaluate `spec.output` (rendering it against a dead context would
    // be misleading and could throw).
    output: !halted && spec.output ? renderValue(spec.output, ctx) : undefined,
  };
}

/**
 * The fixture `parameters` shape for a template: a `defineTemplate` result
 * carries its params' value shape in the `__tdkParams` phantom, which this
 * unwraps; a class template (no phantom) falls back to the loose record.
 */
export type FixtureParams<T> = T extends { readonly __tdkParams?: infer PV }
  ? NonNullable<PV> extends Record<string, unknown>
    ? NonNullable<PV>
    : Record<string, unknown>
  : Record<string, unknown>;

/** Options for `execute`. */
export interface ExecuteOptions {
  /** The target to compile for. Defaults to `{ env: "test" }`. */
  target?: Target;
  /**
   * Opt-in fixture validation: run the fixture's `parameters` against the
   * compiled `spec.parameters` JSON Schema (plus an unknown-name check), and
   * throw a readable error on any violation — so a renamed param or an
   * out-of-enum value fails loudly instead of rendering `undefined`s.
   */
  validateParams?: boolean;
}

/**
 * Simulate one run of a TDK template against a scenario fixture.
 *
 * Compiles the template (env-agnostic here; defaults to a test target with the
 * env-safety check off, since this is a simulation), then renders its
 * interpolations and runs the pure steps.
 *
 * For a `defineTemplate` template the fixture's `parameters` are TYPED against
 * the template's declared params (via the `__tdkParams` phantom); a bare
 * `Template` (no phantom) accepts a loose record.
 *
 * ```ts
 * const { steps, output } = await execute(OrderTicketTemplate, {
 *   parameters: { cake_code: "CAKE-1", filling_type: "GANACHE", … },
 *   user: { ref: "user:default/baker-042", entity: { metadata: { name: "" } } },
 *   secrets: { token: "t" },
 *   steps: { "register-order": { output: { body: "Created", link: "…" } } },
 * });
 * output; // => { text: [{ title: "Order Summary", content: "CAKE ORDER - CAKE-1 - GANACHE" }, … ] }
 * ```
 */
export async function execute<T extends TemplateInput>(
  input: T,
  fixture: ExecuteFixture<FixtureParams<T>>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const target = opts.target ?? { env: "test" };
  // `compileResolved` (not `compile`) so a template using resolver markers can be
  // simulated: markers are resolved to concrete values before the run. For a
  // marker-free template this is identical to a plain compile.
  const { object } = await compileResolved(input, target, {
    checkEnvSafety: false,
    loaded: fixture.loaded,
  });
  if (opts.validateParams) {
    const values = (fixture.parameters ?? {}) as Record<string, unknown>;
    const { valid, errors } = await validateParameters(object.spec.parameters, values);
    if (!valid) {
      const lines = errors.map((e) => `  - ${e.instancePath || "(root)"} ${e.message ?? ""}`);
      throw new Error(
        `execute: fixture parameters failed validation against template "${object.metadata.name}":\n` +
          lines.join("\n"),
      );
    }
  }
  return executeSpec(object.spec as ExecSpec, fixture, target.env);
}

/** The per-scenario comparison of a TDK template run vs. its gold-standard run. */
export interface ExecuteDifferential {
  /** True when output AND every step's output/error agree. */
  ok: boolean;
  outputEqual: boolean;
  stepsEqual: Record<string, boolean>;
  tdk: ExecuteResult;
  gold: ExecuteResult;
}

/**
 * Template-level differential: run `execute` on BOTH the TDK template and the
 * gold-standard YAML (parsed + run through the SAME engine) for one fixture, and
 * assert behavioural equivalence — every jsonata step computes the same result
 * and the final output matches, value-for-value, regardless of expression layout.
 */
export async function executeAgainstGold<P extends Record<string, unknown> = Record<string, unknown>>(
  input: TemplateInput,
  goldYaml: string,
  fixture: ExecuteFixture<P>,
  opts: { target?: Target } = {},
): Promise<ExecuteDifferential> {
  const tdk = await execute(input, fixture, opts);
  const goldEntity = parseYaml(goldYaml) as { spec: ExecSpec };
  const gold = await executeSpec(goldEntity.spec, fixture, opts.target?.env ?? "test");

  const stepsEqual: Record<string, boolean> = {};
  const ids = new Set([...Object.keys(tdk.steps), ...Object.keys(gold.steps)]);
  for (const id of ids) {
    const a = tdk.steps[id];
    const b = gold.steps[id];
    stepsEqual[id] = deepEqual(a?.output, b?.output) && (a?.error ?? null) === (b?.error ?? null);
  }
  const outputEqual = deepEqual(tdk.output, gold.output);
  const ok = outputEqual && Object.values(stepsEqual).every(Boolean);
  return { ok, outputEqual, stepsEqual, tdk, gold };
}

/**
 * Like `executeAgainstGold`, but throws a detailed error when the TDK template
 * and the gold standard disagree for a fixture. Intended for a test body.
 */
export async function assertExecuteAgainstGold<P extends Record<string, unknown> = Record<string, unknown>>(
  input: TemplateInput,
  goldYaml: string,
  fixture: ExecuteFixture<P>,
  opts: { target?: Target } = {},
): Promise<void> {
  const diff = await executeAgainstGold(input, goldYaml, fixture, opts);
  if (diff.ok) return;
  const badSteps = Object.entries(diff.stepsEqual)
    .filter(([, eq]) => !eq)
    .map(
      ([id]) =>
        `  step "${id}":\n` +
        `    tdk:  ${json(diff.tdk.steps[id]?.output)}\n` +
        `    gold: ${json(diff.gold.steps[id]?.output)}`,
    );
  const outLine = diff.outputEqual
    ? ""
    : `  output:\n    tdk:  ${json(diff.tdk.output)}\n    gold: ${json(diff.gold.output)}\n`;
  throw new Error(`executeAgainstGold: TDK template diverged from gold standard:\n${outLine}${badSteps.join("\n")}`);
}

function json(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Normalize for comparison: top `undefined` → null; drop `undefined` members. */
function normalize(v: unknown): unknown {
  if (v === undefined) return null;
  return JSON.parse(JSON.stringify(v ?? null));
}

/** Structural deep-equality on JSON-shaped values (key-order independent). */
function deepEqual(a: unknown, b: unknown): boolean {
  return structEq(normalize(a), normalize(b));
}

function structEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((x, i) => structEq(x, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => structEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
