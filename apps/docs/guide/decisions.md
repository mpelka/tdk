# Design decisions

This page indexes TDK's architecture decision records. An ADR captures one decision — its
context, what was decided, the alternatives, and the consequences — so a settled question
is not re-argued from memory months later. Each record follows the Michael Nygard shape.

A record is immutable. You do not edit a decision away. If a decision changes, you write a
new ADR that supersedes it, and the two link to each other with Supersedes and
Superseded-by. The number and the text of the old record stay as they were.

The records below are grouped by area: the core and language, the toolchain, and the VS
Code extension. Most are recorded retrospectively — they capture decisions that predate
the record — and are marked accepted. One looks forward:
[ADR 25, authoring v2](/guide/decisions/0025-authoring-v2-dataflow-model) is the design
the next implementation phases build against, and it is still proposed.

This page is a companion to the [stability contract](/guide/stability), which records the
promises TDK makes. The three-verb vocabulary the records use — transpile, compile,
execute — is defined in the contributor guide.

## Core and language

| Number | Date | Title | Status |
| --- | --- | --- | --- |
| 0001 | 2026-07-18 | [Compile to YAML artifacts, do not template YAML](/guide/decisions/0001-compile-to-yaml-not-template-yaml) | Accepted |
| 0002 | 2026-07-18 | [The three-verb vocabulary, and compile not synth](/guide/decisions/0002-compile-verb-not-synth) | Accepted |
| 0003 | 2026-07-18 | [Typed lambdas transpiled to JSONata and Nunjucks](/guide/decisions/0003-typed-lambdas-not-embedded-strings) | Accepted |
| 0004 | 2026-07-18 | [Differential testing is the transpiler's trust anchor](/guide/decisions/0004-differential-testing-transpiler-trust-anchor) | Accepted |
| 0005 | 2026-07-18 | [Value-equivalence, never byte-equality](/guide/decisions/0005-value-equivalence-not-byte-equality) | Accepted |
| 0006 | 2026-07-18 | [Move failures from scaffold time to compile or test time](/guide/decisions/0006-fail-at-compile-or-test-not-scaffold-time) | Accepted |
| 0007 | 2026-07-18 | [The simulator matches Backstage](/guide/decisions/0007-simulator-matches-backstage) | Accepted |
| 0008 | 2026-07-18 | [Scenario snapshots are the regression baseline](/guide/decisions/0008-scenario-snapshots-regression-baseline) | Accepted |
| 0009 | 2026-07-18 | [Extension points keep core org-agnostic](/guide/decisions/0009-core-org-agnostic-extension-hooks) | Accepted |
| 0021 | 2026-06-28 | [Pure-TypeScript authoring, no JSX](/guide/decisions/0021-pure-typescript-authoring-no-jsx) | Accepted |
| 0022 | 2026-06-29 | [Functional defineTemplate over class](/guide/decisions/0022-functional-definetemplate-over-class) | Accepted |
| 0024 | 2026-06-29 | [The load() shape: env-aware, parameters-only](/guide/decisions/0024-load-shape-env-aware-parameters-only) | Accepted |
| 0025 | 2026-07-18 | [Authoring v2: the dataflow model](/guide/decisions/0025-authoring-v2-dataflow-model) | Accepted |

## Toolchain

| Number | Date | Title | Status |
| --- | --- | --- | --- |
| 0010 | 2026-07-18 | [Bun end-to-end](/guide/decisions/0010-bun-workspaces-no-turborepo) | Accepted |
| 0011 | 2026-07-18 | [One CI script, vendor-neutral](/guide/decisions/0011-one-vendor-neutral-ci-script) | Accepted |
| 0012 | 2026-07-18 | [Changesets for versioning](/guide/decisions/0012-changesets-for-versioning) | Accepted |
| 0013 | 2026-07-18 | [Push-safety through a synthetic theme](/guide/decisions/0013-push-safety-synthetic-theme) | Accepted |
| 0023 | 2026-06-29 | [SKILL.md over an MCP server](/guide/decisions/0023-skill-md-over-mcp-server) | Accepted |

## VS Code extension

| Number | Date | Title | Status |
| --- | --- | --- | --- |
| 0014 | 2026-07-18 | [The extension shells out to the workspace CLI](/guide/decisions/0014-vscode-shells-out-to-workspace-cli) | Accepted |
| 0015 | 2026-07-18 | [RJSF for the form, Fluent for the theme](/guide/decisions/0015-rjsf-form-fluent-theme) | Accepted |
| 0016 | 2026-07-18 | [One trace panel with two slots](/guide/decisions/0016-one-trace-panel-two-slots) | Accepted |
| 0017 | 2026-07-18 | [Never guess a provenance value](/guide/decisions/0017-never-guess-a-provenance-value) | Accepted |
| 0018 | 2026-07-18 | [Live simulate is gated, dry-run is a click](/guide/decisions/0018-live-simulate-gated-dry-run-explicit) | Accepted |
| 0019 | 2026-07-18 | [Plain-YAML preview is the adoption path](/guide/decisions/0019-plain-yaml-preview-adoption-path) | Accepted |
| 0020 | 2026-07-18 | [Dry-run tokens live in SecretStorage](/guide/decisions/0020-dry-run-tokens-in-secretstorage) | Accepted |

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
