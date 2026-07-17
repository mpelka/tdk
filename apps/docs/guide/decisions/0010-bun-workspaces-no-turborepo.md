# 10. Bun end-to-end

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A multi-package monorepo needs a workspace and task runner and a bundler for the VS Code
webview. The usual defaults add a second build tool — Turborepo or Nx for orchestration,
esbuild or vite or rolldown for bundling.

## Decision

Use Bun end-to-end: Bun workspaces without Turborepo, `bun test` as the test runner, and
`Bun.build` to bundle the VS Code webview. Keep each package's `tsconfig.json`
self-contained, with no shared base to extend.

## Alternatives considered

- Turborepo or Nx, plus esbuild, vite or rolldown — rejected. The repo already requires
  Bun, so a second build tool and an orchestration layer add moving parts with no payoff
  at this size.
- A shared base `tsconfig` via `extends` — rejected. Self-contained configs mean each
  package is readable on its own, without chasing an inheritance chain.

## Consequences

- Using Bun for workspaces, tests and bundling adds no new dependency and no second build
  tool to keep in step.
- Each package is typecheckable and openable on its own.
- If the repo grows enough that task caching and orchestration pay off, Turborepo can be
  layered on later; this is not a one-way door.
