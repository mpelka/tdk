# Get started

This page takes a newcomer from nothing to a compiled, tested template. Follow it
top to bottom.

TDK is a TypeScript DSL that compiles to Backstage Scaffolder template YAML. You
author a template once as a typed `defineTemplate({...})` value and compile it to
one artifact per environment from that single source.

## Install

`@tdk/core` and `@tdk/cli` are not published to a registry yet — every package in
the monorepo is still `private`. Until they are published, link this repo's clone
into your own template repo. There is no build step: `@tdk/core` is consumed as
TypeScript source, so a `git pull` on the clone updates the consumer instantly.

```sh
# once, in the tdk repo — register the packages globally (subshells, so each cd is independent)
(cd packages/core && bun link)
(cd apps/cli      && bun link)
```

```jsonc
// your template repo's package.json
"dependencies":    { "@tdk/core": "link:@tdk/core" },
"devDependencies": { "@tdk/cli":  "link:@tdk/cli"  }
```

```sh
cd <your template repo> && bun install   # node_modules/@tdk/core symlinks to the clone
```

Template files then import cleanly:

```ts
import { defineTemplate, effect, p, page } from "@tdk/core";
```

When the registry is available, swap `link:@tdk/core` for a version range and run
`bun install`. No template code changes.

## Scaffold a template with `tdk init`

The fastest way to see the authoring model, scenario tests and compile loop end to
end is `tdk init [dir]`. It scaffolds a working, testable bakery template into
`[dir]` (default `.`): a `template.ts`, its `__fixtures__/scenarios.ts`, a
`tdk.config.ts` and the first snapshot baseline.

```sh
tdk init my-templates
cd my-templates
```

## Author a template

A template is a plain value — no class, no `new`. You author it as a graph of
module-scope values: each field is a `const`, and `defineTemplate({...})` ties them
together with the metadata, the `pages` (the form), the `effects` (the side-effectful
steps) and an optional `output`:

```ts
import { compile, defineTemplate, effect, p, page } from "@tdk/core";

const name = p.string({ title: "Name", required: true });

const greet = effect("greet", "debug:log", { input: { message: name } });

const Hello = defineTemplate({
  id: "hello",
  title: "Hello",
  type: "service",
  pages: [page("Details", { name })],
  effects: [greet],
});

const { yaml } = compile(Hello, { env: "test", outDir: "dist" });
```

Reference a field by the `const` itself (as `message: name` above — the effect
normalizes it to its `.ref`), or by its `.ref` (a value rendering
<code v-pre>${{ parameters.&lt;name&gt; }}</code>) inside an expression. See
[Author a template](/guide/authoring) for the full model — computed derives, effect
helpers, conditional fields, pages, lifecycle and the loud-error catalogue.

## First compile

Compile a single template to YAML, validated against the Backstage schema by
default:

```sh
tdk compile my-templates/template.ts
```

Or declare a `tdk.config.ts` with your templates and deploy targets, and compile
the whole thing:

```ts
// tdk.config.ts
import { defineConfig } from "@tdk/core";
import { Hello } from "./template.ts";

export default defineConfig({
  templates: [Hello],
  targets: {
    nonprod: { env: "test", outDir: "../hello-nonprod" },
    prod: { env: "prod", outDir: "../hello-prod" },
  },
});
```

```sh
tdk build   # every template × target → each target's outDir, validated
```

See the [CLI reference](/reference/cli) for every command and flag.

## First test

A testable template is a directory holding `template.ts` and
`__fixtures__/scenarios.ts` (which exports
`scenarios: { name, fixture, branches? }[]`). `tdk init` already scaffolded one,
so run its scenarios:

```sh
tdk test              # discover testable templates, run each scenario, snapshot-assert
```

The first run writes the snapshot (`+ written`); every later run compares against
it (`✓ passed` / `✗ failed` + diff). See [Test templates](/guide/testing) for
scenario fixtures, `execute()` and the gold-standard oracle discipline.

## Next steps

- Read [Core concepts](/guide/concepts) for the mental model behind all of this.
- Read [Author a template](/guide/authoring) for the full authoring surface.
- Read [Write expressions](/guide/expressions) for `jsonata()` and `nj()`.
