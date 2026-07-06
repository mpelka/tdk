# 5. `SKILL.md` over an MCP server for the agent-facing surface

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

## Context

A stated goal is to let an AI agent **author and test** templates. There are two
shapes for the agent-facing surface:

1. **An MCP server** — a process that exposes TDK as tools the agent invokes over the
   protocol (`authorTemplate`, `runTest`, …).
2. **A `SKILL.md`** — a markdown skill the agent loads into context that teaches it to
   drive the **existing** CLI and `@tdk/core` API directly.

The agents that matter here run under a **constrained budget** (e.g. a Copilot-sized
token/context budget) and in environments where standing up and hosting server infra
is real friction.

## Decision

Ship **`packages/skill/SKILL.md`** — a single markdown skill — as the agent-facing
surface. **No MCP server.** The skill is the **agent-facing twin of the human docs**:
the same mental model, the same vocabulary, the same synthetic cake/bakery examples,
pointed at the same `@tdk/core` API and `tdk` CLI.

## Rationale

1. **Lighter — no infra.** A skill is a file the agent reads. An MCP server is a
   process to build, host, version, authenticate, and keep alive. For a DSL that is
   "just" TypeScript plus a CLI, zero moving parts beats a standing service.

2. **Token-cheap, which the budget demands.** A focused markdown skill loads once and
   then lets the agent use tools it already has (read/write files, run a shell). An
   MCP layer adds per-call tool-schema and round-trip overhead on every action —
   expensive under a tight context budget, and paid repeatedly.

3. **The agent already holds the right primitives.** Authoring a template is writing a
   `.ts` file; testing it is running `tdk test`. Those are file and shell operations
   the host agent performs natively — wrapping them in MCP tools adds indirection
   without adding capability.

4. **Single source of truth.** The skill mirrors the docs, so the human and agent
   surfaces don't drift; one set of examples (the synthetic theme) serves both.

5. **Portability.** A markdown skill works with any agent that can load skills or
   context. It does not bind TDK to MCP-capable hosts.

## Consequences

- The agent path is `SKILL.md` plus the normal CLI/API — there is nothing to deploy
  or operate.
- The skill carries a **doc-maintenance** obligation, not an infra one: as the twin
  of the docs, it must be kept in lockstep with the API and examples.
- This declines an MCP server as the **default** surface; it does not forbid one. If a
  future need genuinely requires server-mediated capability — e.g. brokered access to
  a live catalog the agent cannot reach directly — an MCP server could be added later
  as a *complement* to the skill.

## Alternatives considered

- **An MCP server as the primary surface** — rejected for the current need: infra and
  token cost with no capability the agent lacks. Revisit only if a real capability
  needs a server.
- **A bespoke agent SDK / wrapper** — heavier than a skill, another package to
  version, and still no capability gain over driving the CLI directly.
- **No agent surface (humans only)** — rejected: agent-authoring is a stated goal, and
  a markdown skill is nearly free to provide.
