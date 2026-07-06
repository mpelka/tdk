# Extend TDK

TDK ships three extension hooks so an outside plugin can add typed authoring sugar
and teach the engine about its own values and actions — without core ever importing
the plugin. Each is a process-wide registry plus a thin factory.

## Value resolvers with `defineResolver`

Drop a deferred marker wherever a value is allowed, and have a registered async
function replace it with a concrete value at compile time. Markers are resolved by
`compileResolved` / `compileAll` (and by `execute`):

```ts
import { defineResolver } from "@tdk/core";

// "Ada Lovelace" → "baker-042" via a (here static) lookup.
export const cakeDecorator = defineResolver(
  "bakery:cakeDecorator",
  (_ctx, name: string) => DECORATORS[name],
);
// ...later, anywhere a value is allowed:
output: () => ({ decorator: cakeDecorator("Ada Lovelace") });
```

A synchronous `compile()` throws if a resolver marker survives unresolved into a
compiled artifact — only the async path (`compileResolved`/`compileAll`) resolves
them.

## Field and action helpers with `defineField` / `defineAction`

Publish typed sugar that compiles down to the existing `p.customField` / `Step`
primitives. `defineAction`'s optional `simulate` registers the action's simulator
(hook 3) at definition time — so defining an action also teaches `execute()` about
it:

```ts
import { defineField, defineAction, type InputValue } from "@tdk/core";

export const flavorPicker = defineField(
  (o: { catalog: string; title?: string; required?: boolean }) => ({
    title: o.title, required: o.required, uiField: "FlavorPicker", uiOptions: { path: o.catalog },
  }),
);

export const registerOrder = defineAction({
  action: "bakery:registerOrder",
  build: (a: { id: string; flavor: InputValue }) => ({ id: a.id, input: { flavor: a.flavor } }),
  simulate: (input) => ({ body: `order:${input.flavor}` }), // hook 3
});
```

For a reusable, typed helper over a custom field extension specifically (a picker, an
entity-details display), build it once with `defineField` and keep it in your own
shared code — core ships the mechanism, not org-specific field names:

```ts
const cakePicker = defineField((o: { title?: string; required?: boolean; catalog: string }) => ({
  title: o.title, required: o.required, uiField: "CakePickerWithDefault", uiOptions: { path: o.catalog },
}));
// ...later: parameters: { cake: cakePicker({ catalog: "bakery-catalog/cakes", required: true }) };
```

## Action simulators with `registerActionSimulator`

Teach `execute()` how a custom action behaves. A simulator receives the step's
rendered input plus an `ActionSimContext` (`stepId`, `env`, and the
`parameters`/`secrets`/`user`/`steps` roots) and returns the step's output. A
`fixture.steps[id]` mock takes precedence over it — the simulator only runs when the
step has no mock. Usually you
register it implicitly via `defineAction`'s `simulate`, but the registry is public:

```ts
import { registerActionSimulator } from "@tdk/core";

registerActionSimulator("bakery:registerOrder", (input) => ({
  body: `order:${input.flavor}`,
  link: `https://bakery.example/orders/${input.flavor}`,
}));
```

For how this precedence plays out in a scenario, see
[mock-wins precedence](/guide/testing#mock-wins-precedence).

## A worked example: all three hooks composed

`packages/core/src/__fixtures__/plugin-bakery/` is a synthetic `@tdk/plugin-bakery` —
a stand-in consumer plugin that proves the three hooks compose. It is deliberately
fictional (a bakery domain, invented decorators) and imports only from the public
barrel, exactly as an outside plugin would — never from core internals. That is what
makes "core never imports a plugin" real:

- `cakeDecorator(name)` — a value resolver (hook 1) backed by a static, fictional
  name-to-id table.
- `flavorPicker(opts)` — a typed field (hook 2) over `p.customField`.
- `registerOrder(args)` — a typed step action (hook 2) for `"bakery:registerOrder"`,
  with a `simulate` (hook 3) that computes the action's output from its input so
  `execute()` can run it.

The Oven Provisioner example in the [gold-standard suite](/guide/testing) exercises
the same three hooks end to end: the resolved value lands in the compiled artifact,
the marker never does, and `execute()` gets simulator-computed outputs. The
[cookbook](/guide/cookbook#plugin-composition) walks it as a recipe.
