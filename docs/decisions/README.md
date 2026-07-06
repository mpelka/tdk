# Architecture Decision Records

This directory records **decisions** about TDK's design — not plans (those live in
the working roadmap) and not proposals. Each ADR captures one decision: its
context, what was decided, and the consequences — so a settled question isn't
re-litigated from memory months later.

**Format:** lightweight ADRs (the Michael Nygard shape — _Context / Decision /
Consequences_). One file per decision, numbered, **append-only**. A decision is
never edited away: if it changes, a new ADR supersedes it and links back. `Status`
is one of `Accepted`, `Superseded by ADR-N`, or `Deprecated`.

> ADR vs RFC: an RFC _proposes before_ deciding; an ADR _records_ a decision
> already made. The files here are ADRs.

## Index

- [0001 — Pure-TypeScript authoring (no JSX)](0001-pure-typescript-authoring-no-jsx.md) — **Accepted**
- [0002 — Functional `defineTemplate` over `class extends Template`](0002-functional-definetemplate-over-class.md) — **Accepted**
- [0003 — The compile verb is `compile`, not `synth`](0003-compile-verb-not-synth.md) — **Accepted**
- [0004 — Core stays org-agnostic; org specifics plug in via extension hooks](0004-core-org-agnostic-extension-hooks.md) — **Accepted**
- [0005 — `SKILL.md` over an MCP server](0005-skill-md-over-mcp-server.md) — **Accepted**
- [0006 — `load()` shape: env-aware, parameters-only, two mock tiers](0006-load-shape-env-aware-parameters-only.md) — **Accepted**
- [0007 — Bun workspaces (no Turborepo); Changesets for versioning](0007-bun-workspaces-changesets.md) — **Accepted**

## Decisions worth backfilling

_All currently-known decisions are now captured as ADRs above (0002–0007 backfilled
2026-06-29). Add new entries here when a settled-but-unrecorded decision turns up._
