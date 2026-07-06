# TDK — Template Development Kit

TDK is a TypeScript DSL that compiles to [Backstage](https://backstage.io) Scaffolder
template YAML — cdk8s for Backstage templates. You author each template once as typed,
testable TypeScript, then compile it to `scaffolder.backstage.io/v1beta3` YAML for every
environment from one source. Values that differ per environment are picked, not
hardcoded, so a compiled artifact for one environment cannot carry another's value.

```ts
import { defineTemplate, p, env, raw, step, compile } from "@tdk/core";

const OrderCake = defineTemplate({
  id: "order-cake",
  title: "Order a cake",
  type: "service",
  tags: ["bakery"],
  parameters: {
    cakeName: p.string({ title: "Cake name", required: true }),
  },
  steps: (f) => [
    step("place", "debug:log", {
      name: "Place order",
      input: {
        oven: env.pick({ test: "test-oven", prod: "prod-oven" }),
        message: raw`Baking ${f.cakeName}`,
      },
    }),
  ],
});

const { yaml } = compile(OrderCake, { env: "prod", outDir: "dist" });
```

## Monorepo layout

TDK uses Bun workspaces, with no Turborepo and no shared `tsconfig.json` — each package
has its own self-contained config, with no base to extend.

| Path | Package | What it is |
| --- | --- | --- |
| `packages/core` | `@tdk/core` | The DSL: the template model, typed params and pages, the TS→JSONata (`jsonata`) and TS→Nunjucks (`nj`) transpilers, `compile`, `validate`, the `execute` scenario simulator, and the extension hooks. |
| `apps/cli` | `@tdk/cli` | The `tdk` command line — `compile`, `build`, `execute`, `test`, `init`. |
| `apps/vscode` | `tdk-vscode` | VS Code extension: live compile preview and a native Test Explorer for scenarios. |
| `apps/docs` | — | The VitePress documentation site. |
| `packages/skill` | `@tdk/skill` | The `SKILL.md` that teaches a coding agent to author and test TDK templates. |
| `examples` | — | Small, runnable example templates. |

## Commands

Run these from the repo root:

```sh
bun install         # link the workspace
bun test            # run every package's tests
bun run typecheck   # typecheck every package
```

Author and test a template with the CLI:

```sh
tdk init [dir]      # scaffold a testable bakery template + config + first snapshot
tdk test [path]     # discover testable templates and snapshot-assert every scenario
```

See [`apps/cli/README.md`](apps/cli/README.md) for the full command surface.

## Read the docs

The [documentation site](apps/docs) is the canonical guide. Run it locally:

```sh
bun run --cwd apps/docs docs:dev
```

## Where to go next

- [Getting started](apps/docs/guide/getting-started.md) — install, scaffold, and compile your first template
- [Concepts](apps/docs/guide/concepts.md) — the model behind TDK and its vocabulary
- [Authoring](apps/docs/guide/authoring.md) — params, pages, steps, env-aware values, and compile-time data
- [Expressions](apps/docs/guide/expressions.md) — write step logic in TypeScript with `jsonata` and `nj`
- [Testing](apps/docs/guide/testing.md) — scenario snapshots and the `execute` simulator
- [Porting](apps/docs/guide/porting.md) — bring existing YAML templates into TDK
- [Cookbook](apps/docs/guide/cookbook.md) — worked recipes for common template shapes
- [Extending](apps/docs/guide/extending.md) — resolvers, custom fields, and custom actions
- [VS Code extension](apps/docs/guide/vscode.md) — compile preview, form preview, the trace panel, and dry-run
- [Stability](apps/docs/guide/stability.md) — the output-stability contract across upgrades
- [Design decisions](apps/docs/guide/decisions.md) — why TDK is built the way it is

## License

TDK is licensed under the [Apache License 2.0](LICENSE).
