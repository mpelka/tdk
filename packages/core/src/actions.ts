// Action simulators for `execute()`.
//
// `execute(template, fixture)` already computes `roadiehq:utils:jsonata` steps
// FOR REAL and mocks every other action's output from the fixture. An action
// simulator teaches `execute()` how a CUSTOM action behaves, so a simulated run
// can cover more than the one built-in pure action — WITHOUT `execute` importing
// any plugin. Core ships only the mechanism: a process-wide registry. A consumer
// plugin registers a simulator (usually via `defineAction`'s `simulate`, see
// extend.ts) that computes a step's output from its rendered input + context.
//
// Mirrors the resolver registry style (resolve.ts): a module-level singleton +
// a `_reset…` for test isolation, same-reference re-registration tolerated.

/**
 * Context handed to an action simulator: the step's id, the target env the
 * simulated run compiles for, plus the same evaluation roots `execute` exposes
 * to `${{ … }}` (parameters/secrets/user/steps). Mirrors the Scaffolder roots
 * so a simulator can read prior step outputs / the user, and stay env-aware.
 */
export interface ActionSimContext {
  stepId: string;
  /** The target Backstage env of the simulated run (execute's target; any env name). */
  env: string;
  parameters: Record<string, unknown>;
  secrets: Record<string, unknown>;
  user: Record<string, unknown>;
  steps: Record<string, { output: unknown }>;
}

/**
 * A registered action simulator: given a step's RENDERED `input` (every `${{ … }}`
 * already resolved) and an `ActionSimContext`, return the step's simulated
 * output. May be async (e.g. to mirror a real action's response shape).
 */
export type ActionSimulator = (input: Record<string, unknown>, ctx: ActionSimContext) => unknown | Promise<unknown>;

/**
 * Registry of every action simulator in the process, by action id. Mirrors the
 * resolver registry (a module-level singleton + a `_reset…` for tests).
 */
const registry = new Map<string, ActionSimulator>();

/** Reset the action-simulator registry (used by tests for isolation). */
export function _resetActionSimulators(): void {
  registry.clear();
}

/**
 * Register a simulator for an action id. Re-registering the SAME function
 * reference is tolerated (module reload); registering a DIFFERENT function under
 * a taken action throws. Mirrors `defineResolver`.
 */
export function registerActionSimulator(action: string, sim: ActionSimulator): void {
  const existing = registry.get(action);
  if (existing && existing !== sim) {
    throw new Error(
      `registerActionSimulator: a different simulator is already registered for "${action}". ` +
        `Action simulators must be unique.`,
    );
  }
  registry.set(action, sim);
}

/** The simulator registered for `action`, or `undefined` if none is. */
export function getActionSimulator(action: string): ActionSimulator | undefined {
  return registry.get(action);
}
