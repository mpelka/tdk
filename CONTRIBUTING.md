# Contributing

## Flow

Branch → PR → self-review → squash-merge. `main` stays releasable; no direct
pushes to `main`.

## Gates (enforced by CI on every PR)

```sh
bun install          # link the workspace
bun run typecheck    # tsc --noEmit, all packages
bun test             # every package's tests
tdk test --ci        # scenario snapshots, strict (never writes)
```

`bun run ci` runs the typecheck + test + scenario-snapshot trio in one go — it's
the exact command CI executes.

All four must be green before merge. `bun install --frozen-lockfile` is what CI
runs — if you add a dependency, commit the `bun.lock` change with it.

## Conventions

- **Commits / PR titles**: `<area>: <what changed>` (`core:`, `cli:`, `skill:`,
  `docs:`, `test:`), imperative mood. Squash-merge keeps one commit per PR,
  titled after the PR.
- **Issues first** for anything non-trivial — the repo's issue list is the
  roadmap; PRs reference the issue they close.
- **Snapshots are committed.** `tdk test -u` to accept intended changes;
  never hand-edit a `.snap`.
- **Fixtures are bakery-themed, always** — see the push-safety section in
  [CLAUDE.md](CLAUDE.md). Zero real or anonymized org tokens.
- Match the surrounding idiom; `bunx biome check --write` touched files.
