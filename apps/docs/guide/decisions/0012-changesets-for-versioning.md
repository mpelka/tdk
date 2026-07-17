# 12. Changesets for versioning

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A multi-package monorepo needs a versioning and release story. The plan is independent
per-package semver, with `@tdk/core` as the canonical TDK version.

## Decision

Use Changesets for per-package versioning, currently dormant because every package is
private. Two changelog flags support the stability promise: a summary that starts with
`output-changing:` marks a change that moves compiled YAML, and one that starts with
`snapshot-affecting:` marks a change that shifts scenario snapshots.

## Alternatives considered

- Manual versioning, by hand-bumping `package.json` and writing changelogs — rejected. It
  is error-prone and does not scale to independent per-package semver.
- Activating Changesets now — rejected. It is a no-op while every package is private, so
  it is kept dormant deliberately.

## Consequences

- The release machinery is recorded now at zero operational cost; it activates only when
  a package flips public and points at a registry.
- The full workflow is in the contributor guide's changeset section, and the flags are
  explained in the
  [stability contract](/guide/stability#a-note-on-what-is-policy-and-what-is-mechanism).
