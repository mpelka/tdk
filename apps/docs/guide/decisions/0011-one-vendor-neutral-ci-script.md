# 11. One CI script, vendor-neutral

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A CI gate can live in one script or be spread across a git host's workflow YAML. TDK's
future home is a different git host, so the gate must not depend on one vendor's workflow
format.

## Decision

Keep the whole gate in one script, `bun run ci`, which runs Biome, the typecheck, the
tests and the scenario snapshots under `--ci`. The GitHub workflow at
`.github/workflows/ci.yml` is a thin caller: it installs and runs `bun run ci`.

## Alternatives considered

- Spreading the gate across workflow YAML — rejected. It would tie the gate to one git
  host and drift from what a contributor runs locally.

## Consequences

- The gate survives a move to a different git host unchanged.
- A contributor runs the exact command CI runs, with no drift between local and CI.
