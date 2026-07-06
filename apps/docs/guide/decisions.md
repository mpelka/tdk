# Design decisions

This page records why TDK is built the way it is. Each entry states the decision, the
alternatives considered, and the reason one won. It is a companion to the
[stability contract](/guide/stability), which records the promises TDK makes, and to
the ADRs in `docs/decisions/`, which record decisions in the Nygard shape.

The entries are grouped by area: the core and language, the toolchain, and the VS
Code extension.

## Core and language

### Compile to YAML artifacts, do not template YAML

TDK is a TypeScript DSL that compiles to Backstage Scaffolder YAML, the cdk8s model.
The alternatives were templating YAML with a text templating language, or authoring
the YAML by hand.

A typed DSL gives you types, tests and refactoring across a whole template, and one
source that compiles to a separate artifact per environment. Templating YAML gives you
none of that — a text templating layer cannot type-check a step input against a
parameter. The compiled YAML stays a reviewable, version-controlled artifact, so
adopting TDK changes nothing about how a template reaches Backstage: you still commit
YAML and Backstage still reads it. The DSL is upstream of the artifact, not a new
runtime in the path.

### The three-verb vocabulary, and "compile" not "synth"

TDK splits its vocabulary into three verbs at three levels: transpile at the
expression level (`jsonata()` and `nj()`), compile at the template level, and execute
for a simulated run. The alternative was cdk8s's own word, synth, for the
template-level step.

Keeping the three words distinct stops the docs and the code from blurring an
expression-level change with a template-level one. Compile was chosen over synth
because synth reads as a cdk8s term of art, while compile is what a reader already
expects a source-to-artifact step to be called. The full rule, including the word
`synthetic` that must never be renamed, is in the contributor guide's vocabulary
section.

### Typed lambdas transpiled to JSONata and Nunjucks, not embedded strings

Expressions are typed TypeScript lambdas that `jsonata()` and `nj()` transpile to
JSONata and Nunjucks. The alternative was to let authors write JSONata and Nunjucks as
embedded strings, the way a raw template does.

Nobody should hand-write JSONata. A hand-written string is unchecked: it can name a
parameter that does not exist, or one that has been renamed, and nothing catches it
until Backstage fails at scaffold time. A lambda is type-checked against the template's
parameters and steps, so a typo or a rename fails at compile time. See
[Write expressions](/guide/expressions) for the transpilers, and the
[expression support reference](/reference/expression-support) for what each maps.

### Differential testing is the transpiler's trust anchor

Every emitted expression is checked against the author's TypeScript function acting as
a JavaScript oracle. The harnesses live at
`packages/core/src/expr/jsonata/differential.ts` and
`packages/core/src/expr/nunjucks/differential.ts`. Each runs the compiled expression
through the real `jsonata` or `nunjucks` engine and the author's TS lambda as an
oracle, then compares the two values fixture by fixture — agreement is throw-aware, so
two runs agree when they return deep-equal values or both throw the same message.

The alternative — asserting the emitted string looks right — would prove nothing about
what it computes. A transpiler bug is the worst kind of bug TDK could have: it would
corrupt templates silently, at scale, with no error anywhere. The differential harness
is the control that stops it. An emission change cannot merge until it proves it is
value-equivalent. See [how equivalence is proven](/guide/stability#how-equivalence-is-proven).

### Value-equivalence, never byte-equality

Gold standards and the stability contract promise that recompiled output stays
semantically equivalent, not byte-identical. The full reasoning, including why
byte-identity would freeze every improvement to how TDK emits YAML, is in the
[stability contract](/guide/stability).

### Move failures from scaffold time to compile or test time

Backstage fails at run time, in front of the template's end user, far from the line
that caused it. TDK's core choice is to move that failure to the earliest, loudest
place it can. The alternative — emitting a best-effort artifact and letting Backstage
sort it out — is what raw YAML already does, and it is the problem.

Several mechanisms carry this out. Compile rejects a JSONata expression used inside a
<code v-pre>${{ }}</code> interpolation (`rejectJsonataInInterpolation` in `compile.ts`), because such
an expression would ship as an inert literal string. Fixtures can be validated against
the compiled schema. Parameters carry human-readable error messages. An unresolved
resolver marker throws in the synchronous compile rather than leaking into the
artifact. The full catalogue of compile-time throws is in
[Core concepts](/guide/concepts#silent-to-loud-why-the-compiler-throws).

### The simulator matches Backstage, even when kinder would be friendlier

`execute()` is held to behavioural fidelity with Backstage. It halts at the first
failed step, and its `if:` truthiness matches Backstage's own `isTruthy`. The
alternative — a simulator that keeps going past a failure, or treats an empty array as
truthy because that is friendlier — was rejected.

A simulator kinder than production teaches wrong lessons. If `execute()` ran the steps
after a failure, a scenario would show a trace that real Backstage never produces, and
the author would trust it. So the halt is faithful to all three of the ways a step can
fail in `execute.ts`: a `roadiehq:utils:jsonata` expression that throws, an input that
fails to render, and a registered action simulator that throws. Each records the error
on its step and halts the run; every later step is marked not reached, and the template
output is undefined. See
[halt at the first failed step](/guide/testing#halt-at-the-first-failed-step).

### Scenario snapshots are the regression baseline, and a mock beats a simulator

Committed `__snapshots__/` files, checked by `tdk test --ci` in CI, are the regression
baseline. Within a fixture, an explicit step mock wins over a registered action
simulator.

The mock-wins rule is deliberate. The mock is the author's intent for this one
scenario; the simulator is the general model of how an action behaves. Specific beats
general. A mock is also the only way to exercise an error shape a simulator will not
produce — a rejected payload, a partial output — so pinning a step's output regardless
of the simulator has to be possible. See
[mock-wins precedence](/guide/testing#mock-wins-precedence).

### Extension points keep core org-agnostic

Plugins extend core through `defineResolver`, `defineField`, `defineAction` and
`registerActionSimulator`, and core never imports a plugin. TDK ships the contract
types; an organisation's field and action pack lives in that organisation's own repo.

The alternative — building an organisation's fields and actions into core — would tie
TDK's release cadence to one organisation's schema and make the repo carry
organisation-specific shapes. Keeping the plugin seam one-directional lets each
organisation's pack evolve on its own cadence while TDK stays org-agnostic. This is
recorded as ADR 0004. See [Extend TDK](/guide/extending) for the hooks.

## Toolchain

### Bun end-to-end

TDK uses Bun workspaces without Turborepo, `bun test` as the test runner, and
`Bun.build` to bundle the VS Code webview, rather than esbuild, vite or rolldown. The
per-package `tsconfig.json` files are self-contained, with no shared base to extend.

The reason is the fewest moving parts. The repo already requires Bun, so using Bun for
workspaces, tests and bundling adds no new dependency and no second build tool to keep
in step. Self-contained tsconfigs mean each package is readable on its own, without
chasing an `extends` chain. This is recorded as ADR 0007.

### One CI script, vendor-neutral

The whole gate is one script, `bun run ci`, which runs Biome, the typecheck, the tests
and the scenario snapshots under `--ci`. The GitHub workflow at `.github/workflows/ci.yml`
is a thin caller: it installs and runs `bun run ci`.

Keeping the gate in a script rather than spread across workflow YAML means the gate
survives a move to a different git host unchanged. The repo's future home is a
different host, so the CI logic must not live in one vendor's workflow format. A
contributor also runs the exact command CI runs, with no drift between local and CI.

### Changesets for versioning

TDK uses Changesets for per-package versioning, currently dormant because every package
is private. The plan is independent per-package semver, with `@tdk/core` as the
canonical TDK version. The changelog flags that mark an output-changing or
snapshot-affecting change support the stability promise. The full workflow is in the
contributor guide's changeset section, and the flags are explained in the
[stability contract](/guide/stability#a-note-on-what-is-policy-and-what-is-mechanism).

### Push-safety through a synthetic theme

The repo carries only the synthetic bakery theme. Real-world templates live in an
un-pushed sibling playground repo, never here. The alternative — developing against
anonymised real templates in this repo — carries a leak risk that anonymisation does
not fully remove.

The bakery theme lets development run at full fidelity against real template shapes,
with zero risk that a real source token reaches a pushable tree. The rule is stated in
the contributor guide's push-safety section.

## VS Code extension

### The extension shells out to the workspace CLI

The extension runs the workspace's own `tdk` CLI, resolved through the chain setting →
workspace binary → `PATH` → `~/.bun/bin`, with no `npx` or `bunx` fallback. The
alternative — bundling a compiler into the extension — was rejected.

The preview has to compile with the exact `tdk` version the project builds with. A
bundled compiler would drift from the project's version and show a preview that does
not match the build. The `npx`/`bunx` fallback is refused for a second reason: the
`tdk` package on the npm registry is an unrelated third party's, and piping template
source to it would be a security hazard. See
[the extension finds your workspace CLI](/guide/vscode#the-extension-finds-your-workspace-cli).

### RJSF for the form, Fluent for the theme

The form preview uses RJSF, and themes it with Fluent UI rather than Backstage's MUI.

RJSF is chosen because Backstage's own form engine is RJSF. Its `dependencies` and
`oneOf` semantics, required handling, ajv validation and `ui:schema` behaviour all come
for free and stay honest, where a reimplementation would diverge silently as Backstage
evolved. The Fluent theme, instead of Backstage's MUI, is chosen because the preview
should look native to VS Code and follow the editor theme. Behavioural fidelity to
Backstage matters; visual fidelity to Backstage does not.

### One trace panel with two slots, not two panels

The trace panel keeps two retained slots, Local simulate and Backstage dry-run, rather
than two separate panels. Backstage's dry-run responses are normalized into the local
trace's schema through per-source adapters, because the local format is the richer one.

The same form values run through the simulator and through the real engine are a
differential view, and comparing them is the whole point. Two separate panels would
split that comparison across two places. Normalizing the dry-run into the local shape
lets one detail component render both, so the two traces read identically and any
difference is a real difference, not a presentation artefact. See
[the TDK Trace panel](/guide/vscode#the-tdk-trace-panel).

### Never guess a provenance value

A dry-run's resolved values are recovered from the scaffolder log best-effort. When a
value cannot be recovered, the row renders the expression alone.

The alternative — showing `undefined`, or a plausible-looking value — would be a
fabricated value the trace cannot stand behind. A row that shows only the expression is
honest about what is known: the source, not the result. See
[provenance rows](/guide/vscode#provenance-rows).

### Live simulate is gated, dry-run is a click

The local simulate runs live as the form changes, but only while the form is valid. The
dry-run is an explicit button.

Simulation is free, so it should be live. A network call to Backstage costs something,
so it should be deliberate. And an invalid form's trace is garbage — an error trace and
downstream noise — that teaches wrong lessons, so the live simulate is gated on
validity rather than run against a half-filled form. See
[gating](/guide/vscode#gating).

### Plain-YAML preview is the adoption path

The form preview and dry-run work on a plain YAML Scaffolder template that never
adopted the DSL. This is deliberate, not a side effect.

A team can point the preview and a dry-run at their existing YAML templates with zero
commitment, then adopt the DSL for the templates where typed authoring pays off. A tool
that only worked on `.ts` sources would demand the commitment before showing the
payoff. See [preview plain YAML templates](/guide/vscode#preview-plain-yaml-templates).

### Dry-run tokens live in SecretStorage

The Backstage bearer token is stored in VS Code SecretStorage, never in a settings
file, and is kept out of logs. A token in `settings.json` would be committed or synced
by accident. SecretStorage is the store built for exactly this. See
[set-up commands](/guide/vscode#set-up-commands).

## Hard-won implementation notes

These are for a future contributor working on the extension. Each is a trap the repo
already fell into and fixed.

- CommonJS default imports bind the module namespace under Bun's browser bundling.
  Import the named `customizeValidator` from `@rjsf/validator-ajv8`, never the default
  — a default import resolves to the whole namespace object, whose `.isValid` is not a
  function, which kills every form interaction the moment RJSF validates.
- The form webview's Content-Security-Policy needs `'unsafe-eval'` because ajv compiles
  each schema at runtime through the `Function` constructor, and the schemas only exist
  at runtime. The eval surface is scoped to the nonce-gated local bundle; no remote
  script can load. The trace webview needs no `'unsafe-eval'`.
- happy-dom cannot drive Fluent popup positioning, so the trace view uses plain
  Fluent-styled buttons rather than Fluent's `TabList`, and the tests drive the view
  through protocol messages and those plain-button controls.
- The webview has a two-layer test strategy: React Testing Library against the source,
  and a smoke test against the built production bundle. A bundler-seam bug — a peer
  resolved to two copies, a CommonJS interop that only breaks after bundling — is
  invisible to a source-level runtime test, so the built-bundle test is the one that
  catches it.
- Wait on the condition, never on a proxy for it. The async tests poll for the state
  they expect, with no fixed `sleep` standing in for it.
