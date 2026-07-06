// A SYNTHETIC "@tdk/plugin-bakery" — a stand-in consumer plugin that proves the
// three extension hooks compose. It is deliberately fictional (a bakery domain,
// invented decorators) and reproduces NO real template. It imports ONLY from the
// public barrel (`../../index.ts`), exactly as an outside plugin would — never
// from core internals — which is what makes "core never imports a plugin" real.
//
//   - `cakeDecorator(name)` — a value RESOLVER (Hook A) backed by a static,
//     fictional name → id table.
//   - `flavorPicker(opts)`  — a typed FIELD (Hook B) over `p.customField`.
//   - `registerOrder(args)` — a typed step ACTION (Hook B) for
//     "bakery:registerOrder", WITH a `simulate` (Hook C) that computes the
//     action's output from its input so `execute()` can run it.

import type { InputValue } from "../../index.ts";
import { defineAction, defineField, defineResolver, registerActionSimulator } from "../../index.ts";

/** A fictional decorator name → id table (the stand-in for a directory lookup). */
const DECORATORS: Record<string, string> = {
  "Ada Lovelace": "deco-ada",
  "Grace Hopper": "deco-grace",
};

/**
 * Resolver fn: turn a decorator's display name into its bakery id. A stable
 * module-level reference so `installBakery()` can re-register it after a reset.
 * Throws on an unknown name so a typo fails the build, not the artifact.
 */
const lookupDecorator = (_ctx: { env: string }, name: string): string => {
  const id = DECORATORS[name];
  if (!id) throw new Error(`cakeDecorator: unknown decorator "${name}"`);
  return id;
};

/**
 * Action simulator: compute a `bakery:registerOrder` order receipt from the
 * step's rendered input. A stable reference for the same reason as above.
 */
const simulateOrder = (input: Record<string, unknown>): { body: string; link: string } => ({
  body: `order:${input.flavor}`,
  link: `https://bakery.example/orders/${input.flavor}`,
});

/**
 * HOOK A (resolver): `cakeDecorator("Ada Lovelace")` drops a marker that compile
 * replaces with the resolved bakery id. `defineResolver` registers
 * `lookupDecorator` at import.
 */
export const cakeDecorator = defineResolver("bakery:cakeDecorator", lookupDecorator);

/**
 * HOOK B (field): a "pick a cake flavor" custom field. Maps the plugin's small
 * options to the generic `p.customField` shape — emits `ui:field: FlavorPicker`
 * and the catalog path under `ui:options`. Touches no registry.
 */
export const flavorPicker = defineField((o: { catalog: string; title?: string; required?: boolean }) => ({
  title: o.title,
  required: o.required,
  uiField: "FlavorPicker",
  uiOptions: { path: o.catalog },
}));

/**
 * HOOK B (action) + HOOK C (simulator): `registerOrder({ id, flavor })` yields a
 * `bakery:registerOrder` step, and its `simulate` registers `simulateOrder` so
 * `execute()` can run the step without a fixture mock.
 */
export const registerOrder = defineAction({
  action: "bakery:registerOrder",
  build: (a: { id: string; flavor: InputValue }) => ({
    id: a.id,
    input: { flavor: a.flavor },
  }),
  simulate: simulateOrder,
});

/**
 * Re-apply the registry-backed hooks (the resolver + the action simulator).
 * Defining the helpers above already did this at import; this lets a test
 * re-register the SAME stable references after it clears the registries for
 * isolation (same-reference re-registration is tolerated by both registries).
 */
export function installBakery(): void {
  defineResolver("bakery:cakeDecorator", lookupDecorator);
  registerActionSimulator("bakery:registerOrder", simulateOrder);
}
