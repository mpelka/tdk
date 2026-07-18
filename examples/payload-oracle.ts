// The payload oracle — the phase-4 migration's behaviour-preservation proof.
//
// The playground migration pattern: prove a v1→v2 rewrite is behaviour-preserving by
// comparing FINAL PAYLOADS, not step topology. The dataflow rewrite (`derive`,
// `effect`, pages-as-TOC, handle output) is free to rename/reorder steps, split a
// computed value into more `roadiehq:utils:jsonata` steps, or re-lay-out an
// expression — none of that is observable. What MUST be preserved is:
//
//   1. the template `output` map (the run's final payload), and
//   2. the fully-rendered input (and computed/mocked output) delivered to each
//      genuine EFFECT — a side-effectful action step, i.e. any step that is NOT a
//      `roadiehq:utils:jsonata` computed value.
//
// So `payloadDigest(steps, result)` keeps (1) and (2) and DROPS the jsonata/derive
// steps entirely (pure topology). Effects are keyed by their action id, which is
// stable across the rewrite and distinct per example. A migrated example captures
// this digest from its v1 template BEFORE the rewrite (`__baseline__/payloads.json`),
// then its `payload-equivalence.test.ts` asserts the v2 template reproduces it
// scenario-for-scenario (`toEqual`, so key order is irrelevant).

import type { ExecuteResult } from "@tdk/core";

/** A step whose id/action the digest needs to classify the execute result. */
export interface CompiledStep {
  id?: string;
  action: string;
}

/** One effect reduced to the payload it received and produced. */
export interface EffectPayload {
  /** The step's `input`, every `${{ … }}` resolved — what the action receives. */
  input: unknown;
  /** The effect's computed (simulated) or mocked output, when present. */
  output?: unknown;
  /** True when the effect's `if:` was falsy and it did not run. */
  skipped?: boolean;
}

/** A whole run reduced to its final payloads: the template output + effect payloads. */
export interface PayloadDigest {
  output: unknown;
  /** Effect payloads keyed by action id (distinct per example, stable across rewrite). */
  effects: Record<string, EffectPayload>;
}

/** The roadie action a `derive` (and any computed value) materializes to — pure topology. */
const COMPUTED_ACTION = "roadiehq:utils:jsonata";

/**
 * Reduce an `execute()` result to its behaviour-preserving digest: the template
 * `output`, plus each EFFECT's resolved input/output keyed by action id. Steps whose
 * action is `roadiehq:utils:jsonata` (derives / computed values) are dropped — they
 * are topology the rewrite may reshape. Throws if two effects share an action id (the
 * per-action keying would collide) so a mis-keyed digest fails loudly, not silently.
 */
export function payloadDigest(steps: readonly CompiledStep[], result: ExecuteResult): PayloadDigest {
  const idToAction = new Map<string, string>();
  for (const s of steps) if (s.id !== undefined) idToAction.set(s.id, s.action);

  const effects: Record<string, EffectPayload> = {};
  for (const [id, r] of Object.entries(result.steps)) {
    const action = idToAction.get(id) ?? id;
    if (action === COMPUTED_ACTION) continue; // a derive/computed step — topology, skip
    if (Object.hasOwn(effects, action)) {
      throw new Error(`payloadDigest: two effects share action "${action}" — key them by role instead.`);
    }
    const payload: EffectPayload = { input: r.input };
    if (r.output !== undefined) payload.output = r.output;
    if (r.skipped) payload.skipped = true;
    effects[action] = payload;
  }
  return { output: result.output, effects };
}
