# TDK — contributor and agent guide

This guide is for anyone working on TDK — a human contributor or a coding agent. Follow it
to make changes that match the codebase.

TDK (Template Development Kit) is a TypeScript DSL that compiles to Backstage Scaffolder
template YAML — cdk8s for Backstage templates. You author templates as typed, testable
TypeScript, then compile them to `scaffolder.backstage.io/v1beta3` YAML for every
environment from one source.

For why TDK is built the way it is — the decisions behind the DSL, the toolchain, and the
VS Code extension — see the [design decisions](apps/docs/guide/decisions.md) page.

## Monorepo layout

TDK uses Bun workspaces, with no Turborepo.

- `packages/core` — `@tdk/core`: the DSL. The template model (`defineTemplate`), params and
  pages, the TS→JSONata (`jsonata()`) and TS→Nunjucks (`nj()`) transpilers, `compile`,
  `validate`, the `execute` scenario simulator, and the three extension hooks.
- `apps/cli` — `@tdk/cli`: the `tdk` command line.
- `apps/vscode` — `tdk-vscode`: the VS Code extension (live compile preview and a native
  Test Explorer).
- `apps/docs` — the VitePress documentation site.
- `packages/skill` — the `SKILL.md` that teaches an agent to author and test TDK templates.
- `examples` — `@tdk/examples`: gold-standard example templates, each with a hand-written
  `gold-standard.yaml` and scenario tests.

Each package has its own self-contained `tsconfig.json`. There is no shared base and no
`extends`.

## Commands

Run these from the repo root:

- `bun install` — link the workspace
- `bun test` — run every package's tests
- `bun run typecheck` — typecheck all packages (`--filter '*'`)
- `bun run ci` — the full gate (typecheck + tests + scenario snapshots); the exact command CI runs
- `tdk build` / `tdk compile <template.ts>` / `tdk execute <template.ts>` — the CLI (see
  `apps/cli`)
- `tdk init [dir]` — scaffold a testable bakery template
- `tdk test [path]` — run scenario snapshot tests (`--list` for discovery only)

## Scenario testing

A testable template is a directory holding `template.ts` and `__fixtures__/scenarios.ts`
(which exports `scenarios: { name, fixture, branches? }[]`). `tdk test [path]` discovers
them workspace-wide, runs each scenario through `execute()`, and snapshot-asserts the
result.

- Snapshots live as siblings of `__fixtures__/`, at `__snapshots__/scenarios.snap` (YAML,
  one per template). `__fixtures__/` and `__snapshots__/` are siblings — not nested.
- The first run writes snapshots (`+ written`); later runs compare (`✓ passed` or
  `✗ failed`, with a diff). `tdk test -u` accepts changes; `tdk test --ci` fails on a
  missing snapshot and never writes.
- The same engine drives the VS Code Test Explorer (the native Testing view): suites are
  templates, tests are scenarios. A mismatch shows as a failing test with the native
  expected-against-actual diff, plus an Update Snapshots run profile. The per-step resolved
  trace shows in the test output.
- Commit `__snapshots__/` alongside the template — it is the regression baseline.

## Vocabulary — keep these distinct

- transpile — expression level: `jsonata()` (TS→JSONata), `nj()` (TS→Nunjucks).
- compile — template level: `compile(template, target)` → YAML. Renamed from `synth`: cdk8s
  calls it synth, we use compile. The unrelated word `synthetic` (fixtures and theme) must
  never be renamed.
- execute — `execute(template, fixture)` simulates one run of a compiled template.

## ⛔ Push-safety (critical)

This repo is pushable. It must contain **NO real or anonymized Backstage templates** — not
even scrubbed ones. All fixtures and examples use the synthetic **cake-order / bakery**
theme. Real (anonymized) templates live ONLY in the un-pushed sibling repo `tdk-playground`.
Before committing, there must be **zero real-source tokens** in the tree or history.

## Extension points

Plugins extend core without core ever importing them.

- `defineResolver(name, fn)` — async value resolvers. A marker like `person("…")` is
  resolved at compile time (for example, a directory lookup). `compileResolved` and
  `compileAll` run them; the synchronous `compile` throws on an unresolved marker.
- `defineField` / `defineAction` — typed field and step-action sugar. `defineAction`'s
  optional `simulate` also registers the action's `execute()` simulator.
- `registerActionSimulator(action, fn)` — teach `execute()` how a custom action behaves.

See `packages/core/src/__fixtures__/plugin-bakery` for all three composed.

## Versioning — Changesets

Changesets is an independent, runtime-agnostic tool (the npm package `@changesets/cli`; not
part of Node or Bun — `bun changeset` just runs it via bun). In a monorepo it automates
per-package version bumps, changelogs, and publishing. The key idea: it separates recording
what changed (as you work) from computing versions and publishing (a batch at release time).

Workflow:

1. After a change, run `bun changeset`. Pick the changed packages, the bump size (patch,
   minor, or major), and a one-line summary. It writes a `.changeset/*.md` note and changes
   no versions yet. Commit it with the code.
2. Notes accumulate over many commits.
3. At release time, run `bun changeset version`. It reads the notes, bumps each
   `package.json`, writes the `CHANGELOG.md` files, updates internal dependency ranges, and
   deletes the notes. Review and commit.
4. Run `bun changeset publish` to publish the bumped packages to the registry (Artifactory).

Semver: patch is a bugfix, minor is a backward-compatible feature, major is a breaking
change. Before 1.0 (0.x), the rules loosen.

Flag convention. A changeset whose change alters compiled YAML output must start its
summary with `output-changing:`. A changeset whose change alters `execute()`/simulator
behavior — and so shifts scenario snapshots — must start its summary with
`snapshot-affecting:`. Both up front, so a changelog reader knows immediately that
recompiling or re-running snapshots after the bump will produce diffs. See the docs
[stability contract](apps/docs/guide/stability.md) for the promise these flags support.

Status: dormant. Every package is `private: true`, and Changesets ignores private packages,
so it currently does nothing. To activate, flip `private` off on the packages to publish and
point at Artifactory. The plan is independent per-package semver: `@tdk/core` is the
canonical TDK version; `@tdk/vscode` versions on its own marketplace track via `vsce`; the
docs are never published.

## Working style

- Do not commit unless asked.
- Never use `rm` — use `trash`.
- Match the surrounding idiom.
