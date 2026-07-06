# TDK — VS Code extension

The developer surface for [`@tdk/core`](../../packages/core). It gives you a live compile
preview, an interactive form preview, a two-slot trace panel with a dry-run against a real
Backstage, and every template's scenarios wired into VS Code's native Test Explorer.

Everything shells out to the workspace's own `tdk` CLI — the extension bundles no compiler
of its own, so the preview always matches the version your project builds with.

## Read the docs

The [VS Code extension guide](../docs/guide/vscode.md) is the canonical walkthrough — the
compile preview, the form preview (env picker, scenario prefill, save-as-scenario, reset),
the TDK Trace panel (the two slots, the glyph legend, provenance, gating), dry-run in
Backstage (the set-up commands, run history, the failure outcomes), plain-YAML preview, and
the Test Explorer integration. Run the docs site locally with
`bun run --cwd apps/docs docs:dev`.

For the reasoning behind the extension's shape — why it shells out to the workspace CLI, why
RJSF and Fluent, why one trace panel with two slots — see the
[design decisions](../docs/guide/decisions.md#vs-code-extension).

## Develop

```sh
bun install        # from the monorepo root
bun run build      # bundle src/ -> dist/ (extension host + webview apps, via Bun.build)
bun run watch      # rebuild both bundles on change
bun run typecheck  # tsc --noEmit
```

Then press F5 in VS Code to launch an Extension Development Host.

## Publishing

<!-- TODO: `publisher: "tdk"` in package.json is a PLACEHOLDER — replace it with
     the real VS Code Marketplace / Open VSX publisher id before `vsce publish`.
     The `@tdk/vscode` package versions on its own marketplace track (via `vsce`),
     independent of `@tdk/core`. A LICENSE is still pending with the maintainer. -->

Not yet published. The extension is `private` in `package.json`; publishing is tracked
separately, in the TODO above. To build a shareable `.vsix` in the meantime, run
`bunx @vscode/vsce package --no-dependencies` in this directory — the flag is required
because vsce's dependency scan shells out to `npm list`, which fails on the Bun
workspace layout, and the build already bundles everything into `dist/`. Add
`--skip-license` to silence the LICENSE warning while the licence decision is pending.
