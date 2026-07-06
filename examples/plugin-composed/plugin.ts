// A small INLINE consumer plugin for the Oven Provisioner example — the three
// extension hooks composed, mirroring `plugin-bakery` WITHOUT importing it (each
// example is self-contained). Like a real consumer plugin it imports ONLY the
// public `@tdk/core` barrel — never core internals — which is what keeps "core
// never imports a plugin" honest.
//
//   - HOOK A (resolver): `headBakerOf(station)` drops a marker that compile replaces
//     with the resolved head-baker id (a static station → id table stands in for a
//     directory lookup).
//   - HOOK B (field): `cakePicker(opts)` — a typed field over `p.customField`, the
//     CakePickerWithDefault picker (emits `ui:field` + `ui:options`).
//   - HOOK B (action) + HOOK C (simulator): `provisionOven(args)` yields a
//     `bakery:provision-oven` step, and its `simulate` computes the step's output
//     from the RENDERED input, so `execute()` runs it with no fixture mock.

import {
  defineAction,
  defineField,
  defineResolver,
  type InputValue,
  registerActionSimulator,
  type Step,
} from "@tdk/core";

/** A fictional station → head-baker id table (stand-in for a directory lookup). */
const HEAD_BAKERS: Record<string, string> = {
  pastry: "baker-pastry-01",
  bread: "baker-bread-07",
};

/**
 * Resolver fn: turn a station name into its head baker's id. A stable
 * module-level reference so `installOvenPlugin()` can re-register it after a reset.
 * Throws on an unknown station so a typo fails the build, not the artifact.
 */
const lookupHeadBaker = (_ctx: { env: string }, station: string): string => {
  const id = HEAD_BAKERS[station];
  if (!id) throw new Error(`headBakerOf: unknown station "${station}"`);
  return id;
};

/**
 * Action simulator: compute a `bakery:provision-oven` receipt from the step's
 * RENDERED input (mirroring how the real action would behave). A stable reference
 * for the same reason as above.
 */
const simulateProvision = (input: Record<string, unknown>): { ovenId: string; endpoint: string; ready: boolean } => ({
  ovenId: `oven-${input.station}-${input.capacity}`,
  endpoint: `https://ovens.example/${input.station}/${input.capacity}`,
  ready: true,
});

/** HOOK A (resolver): `headBakerOf("pastry")` → the resolved head-baker id. */
export const headBakerOf = defineResolver("bakery:headBakerOf", lookupHeadBaker);

/**
 * HOOK B (field): the CakePickerWithDefault picker over `p.customField`. Emits
 * `ui:field: CakePickerWithDefault` and the catalog path + default under
 * `ui:options`.
 */
export const cakePicker = defineField(
  (o: { catalog: string; default?: string; title?: string; required?: boolean }) => ({
    title: o.title,
    required: o.required,
    uiField: "CakePickerWithDefault",
    uiOptions: { path: o.catalog, ...(o.default !== undefined ? { default: o.default } : {}) },
  }),
);

/**
 * HOOK B (action) + HOOK C (simulator): `provisionOven({ id, station, capacity, model })`
 * yields the `bakery:provision-oven` step, and its `simulate` registers
 * `simulateProvision` so `execute()` runs the step without a fixture mock. `model` is
 * the oven model to provision — this is where the CakePickerWithDefault field's value
 * (`f.ovenModel`) is actually CONSUMED, so it appears in the step input, not just the
 * form. The simulator keys its receipt on station + capacity, so carrying `model`
 * leaves the output unchanged.
 */
export const provisionOven = defineAction({
  action: "bakery:provision-oven",
  build: (a: { id: string; station: InputValue; capacity: InputValue; model: InputValue; if?: Step["if"] }) => ({
    id: a.id,
    input: { station: a.station, capacity: a.capacity, model: a.model },
    ...(a.if !== undefined ? { if: a.if } : {}),
  }),
  simulate: simulateProvision,
});

/**
 * Re-apply the registry-backed hooks (the resolver + the action simulator).
 * Defining the helpers above already did this at import; this lets a test
 * re-register the SAME stable references after it clears the registries for
 * isolation (same-reference re-registration is tolerated by both registries).
 */
export function installOvenPlugin(): void {
  defineResolver("bakery:headBakerOf", lookupHeadBaker);
  registerActionSimulator("bakery:provision-oven", simulateProvision);
}
