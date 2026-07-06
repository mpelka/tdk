# @tdk/core

`@tdk/core` is the TDK DSL. You author a Backstage Scaffolder template once as a typed
`defineTemplate({...})` value and compile it to a schema-valid `Template` entity — one per
deploy environment. A template is a plain value you can unit-test in TypeScript, with no
Backstage runtime.

The package holds the whole DSL: the template model, typed `p.*` params and multi-page
forms, the TS→JSONata (`jsonata`) and TS→Nunjucks (`nj`) transpilers, `compile`, `validate`,
the `execute` scenario simulator, and the extension hooks. The
[`tdk` CLI](../../apps/cli) drives it from the command line.

## Authoring a template

A template has metadata plus three parts: `parameters` (the form), `steps` (a function of
the typed field-ref map `f`), and an optional `output`. Values that differ per environment
use `env.pick`, so they resolve per target and can never leak across environments.

```ts
import { defineTemplate, p, env, raw, step } from "@tdk/core";

export const OrderCake = defineTemplate({
  id: "order-cake",
  title: "Order a cake",
  description: "Order a cake from a partner bakery.",
  type: "service",
  tags: ["bakery"],
  parameters: {
    bakeryCode: p.string({ title: "Bakery code", pattern: "^[A-Z]{2,10}$", required: true }),
    cakeName: p.string({ title: "Cake name", required: true }),
  },
  steps: (f) => [
    step("place", "debug:log", {
      name: "Place order",
      input: {
        oven: env.pick({ test: "test-oven", prod: "prod-oven" }),
        message: raw`Baking ${f.cakeName} (${f.bakeryCode})`,
      },
    }),
  ],
  output: (f) => ({ orderUrl: raw`https://bakery.example/orders/${f.bakeryCode}` }),
});
```

`f.<name>` is the param's typed `.ref` (rendering `${{ parameters.<name> }}`), so values
stay typed everywhere a step or output uses them. Compile it with the CLI —
`tdk compile order-cake/template.ts` — or from the API with `compile`, `compileResolved`, or
`compileAll`.

## Getting started

```sh
bun install
bun test            # run the suite (tests are colocated next to the code)
bun run typecheck   # tsc --noEmit
```

To scaffold a working, testable template to start from, run `tdk init`. It writes a bakery
`template.ts`, its `__fixtures__/scenarios.ts`, a `tdk.config.ts`, and the first snapshot
baseline.

## Read the docs

The [documentation site](../../apps/docs) is the canonical guide — run it locally with
`bun run --cwd apps/docs docs:dev`.

- [Authoring](../../apps/docs/guide/authoring.md) — every param type, pages, conditional
  fields (`showWhen`, `dep.when`), `env.pick`, compile-time data (`load`), lifecycle gating,
  `extraSpec`, and the compile-fails-loudly checks
- [Expressions guide](../../apps/docs/guide/expressions.md) — write step logic in TypeScript
  with `jsonata` and `nj`, including block-bodied arrows and the differential harness
- [Expression support reference](../../apps/docs/reference/expression-support.md) — the
  authoritative construct tables and every semantic divergence
- [Testing](../../apps/docs/guide/testing.md) — the `execute` simulator, scenario snapshots,
  and gold-standard differentials
- [Extending](../../apps/docs/guide/extending.md) — `defineResolver`, `defineField`,
  `defineAction`, and `registerActionSimulator`

## Source layout

Tests are colocated with the code they cover, and the library suite depends only on
synthetic fixtures under `src/__fixtures__/`. The public API is the `src/index.ts` barrel.
Tracked capability gaps live at `docs/benchmark-gaps.md`; the authoritative
expression-support reference is on the docs site (linked above).
