// Registrable field types & step-action helpers — typed authoring sugar.
//
// A consumer plugin uses these to publish its OWN field and step helpers without
// core importing the plugin. There is NO new runtime machinery here: both helpers
// are thin, typed factories that compile straight down to existing primitives —
// `defineField` wraps `p.customField` (the generic custom-field escape hatch) and
// `defineAction` wraps a `Step` literal.
//
// `defineAction`'s optional `simulate` is the elegant coupling with the action
// simulators hook (actions.ts): DEFINING an action also teaches `execute()` how
// to simulate it, by registering the simulator at definition time.

import type { ActionSimulator } from "./actions.ts";
import { registerActionSimulator } from "./actions.ts";
import type { CustomFieldOptions, ParamBase } from "./params.ts";
import { p } from "./params.ts";
import type { Step } from "./template.ts";

/**
 * Build a reusable, typed FIELD helper from a mapping of a plugin's own options
 * to the generic `CustomFieldOptions` shape `p.customField` accepts. The returned
 * function is what the plugin publishes; calling it yields a `Param` whose
 * compiled schema carries the `ui:field`/`ui:options`/title/required the
 * mapping produced.
 *
 * ```ts
 * const flavorPicker = defineField(
 *   (o: { catalog: string; title?: string; required?: boolean }) => ({
 *     title: o.title,
 *     required: o.required,
 *     uiField: "FlavorPicker",
 *     uiOptions: { path: o.catalog },
 *   }),
 * );
 * // ...later, in a Template's params:
 * params = { flavor: flavorPicker({ catalog: "bakery/flavors", required: true }) };
 * ```
 */
export function defineField<Opts extends object>(
  toCustomField: (opts: Opts) => CustomFieldOptions,
): (opts: Opts) => ParamBase<unknown> {
  return (opts: Opts) => p.customField(toCustomField(opts));
}

/**
 * Build a reusable, typed STEP helper for one custom action. The returned helper
 * maps its args to a `Step` of `{ action, ...build(args) }`. When `simulate` is
 * provided, it is registered as the action's `execute()` simulator at definition
 * time (the action simulators hook) — so defining the action also teaches the
 * scenario simulator how the action behaves.
 *
 * ```ts
 * const registerOrder = defineAction({
 *   action: "bakery:registerOrder",
 *   build: (a: { id: string; flavor: InputValue }) => ({
 *     id: a.id,
 *     input: { flavor: a.flavor },
 *   }),
 *   simulate: (input) => ({ body: `order:${input.flavor}` }),
 * });
 * ```
 */
export function defineAction<Args extends object>(spec: {
  action: string;
  build: (args: Args) => Omit<Step, "action">;
  simulate?: ActionSimulator;
}): (args: Args) => Step {
  if (spec.simulate) registerActionSimulator(spec.action, spec.simulate);
  return (args: Args): Step => ({ action: spec.action, ...spec.build(args) });
}
