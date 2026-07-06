# 7. Bun workspaces (no Turborepo); Changesets for versioning (dormant pre-publish)

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

> *Errata (2026-07-02): this ADR names the VS Code package `@tdk/vscode`; the actual
> package name is `tdk-vscode` (marketplace convention). It also cites the retired root
> script `bun run compile` — the CLI's whole-config build is now `tdk build` (commit
> 1b4e8ce). Neither changes the decision (Bun workspaces + dormant Changesets).*

## Context

A multi-package monorepo (`@tdk/core`, `@tdk/cli`, `@tdk/docs`, `@tdk/vscode`) needs
two things decided: (a) a **workspace / task runner**, and (b) a
**versioning / release** story. The usual defaults are Turborepo (or Nx) for task
orchestration and caching, plus some versioning tool. This repo is small, currently
**all-private** (nothing has been published yet), and values low ceremony.

## Decision

- **Use Bun workspaces** as the monorepo and task runner — **no Turborepo / Nx**.
  Tasks fan out with `bun run --filter` (e.g. `--filter '*' typecheck`). Each package
  has a **self-contained `tsconfig.json`** — no shared base, no `extends`.
- **Use Changesets** for versioning, changelogs, and publishing, kept **dormant**
  until the first publish. The plan is **independent per-package semver**, with
  `@tdk/core` as the canonical "TDK version."

## Rationale

1. **Bun is fast enough that a separate task-graph / cache layer earns nothing here.**
   The build is TypeScript type-stripping plus `bun test`; `bun run --filter` already
   runs per-package scripts across the workspace. Turborepo's remote-cache and
   task-graph value shows up at a scale — many packages, heavy builds — that this repo
   does not have.

2. **Fewer tools means less config and less drift.** No `turbo.json`, no pipeline
   definitions to keep in sync with package scripts. One runtime (Bun) installs, runs
   scripts, runs tests, and executes the CLI.

3. **Self-contained per-package tsconfigs over a shared base.** Each package is
   independently typecheckable and openable with no hidden inheritance. The cost — a
   little duplication — buys clarity and isolation, which suits a kit meant to be
   understood package-by-package.

4. **Changesets is runtime-agnostic and separates the two jobs cleanly.** It is the
   npm package `@changesets/cli` (run via `bun changeset`), not part of Node or Bun.
   It separates *recording what changed* (as you work) from *computing versions and
   publishing* (a batch at release time) — exactly the model independent per-package
   semver wants.

5. **Dormant by design.** Every package is `private: true`, and Changesets ignores
   private packages, so it currently does nothing. The release machinery is recorded
   now at zero operational cost; it activates only when a package flips public and
   points at a registry.

## Consequences

- Contributors use Bun for everything (`bun install`, `bun test`,
  `bun run typecheck`, `bun run compile`); there is no Turbo to learn.
- This is **not a one-way door**: if the repo grows enough that task caching and
  orchestration pay off, Turborepo can be layered on top of the Bun workspaces later.
- Versioning is staged and ready: to activate, flip `private` off on the package(s)
  to publish, point at the registry, and run the Changesets flow
  (`bun changeset` → `bun changeset version` → `bun changeset publish`).
- Independent per-package semver lets `@tdk/vscode` track its marketplace cadence
  (via `vsce`) on its own; `@tdk/docs` is never published.

## Alternatives considered

- **Turborepo / Nx now** — rejected: orchestration and caching overhead with no
  payoff at this size. Revisit if scale demands it.
- **A shared base `tsconfig` via `extends`** — rejected: couples packages through
  hidden inheritance; self-contained configs read clearer here.
- **Manual versioning** (hand-bump `package.json` and write changelogs) — rejected:
  error-prone and doesn't scale to independent per-package semver, which is exactly
  what Changesets automates.
- **Activate Changesets now** — pointless while every package is private (it is a
  no-op); kept dormant deliberately.
