# 23. SKILL.md over an MCP server for the agent-facing surface

- Status: Accepted — backfilled 2026-06-29, recording a decision settled early in
  development
- Date: relocated into the docs ADR set 2026-07-18

## Context

A stated goal is to let an AI agent author and test templates. There are two shapes for
the agent-facing surface:

1. an MCP server — a process that exposes TDK as tools the agent invokes over the
   protocol
2. a `SKILL.md` — a markdown skill the agent loads into context that teaches it to drive
   the existing CLI and `@tdk/core` API directly

The agents that matter here run under a constrained token budget and in environments
where standing up and hosting server infra is real friction.

## Decision

Ship `packages/skill/SKILL.md`, a single markdown skill, as the agent-facing surface. No
MCP server. The skill is the agent-facing twin of the human docs: the same mental model,
the same vocabulary, the same synthetic cake-order examples, pointed at the same
`@tdk/core` API and `tdk` CLI. The reasoning:

1. Lighter, with no infra. A skill is a file the agent reads. An MCP server is a process
   to build, host, version, authenticate and keep alive. For a DSL that is TypeScript
   plus a CLI, zero moving parts beats a standing service.
2. Token-cheap, which the budget demands. A focused markdown skill loads once and then
   lets the agent use tools it already has. An MCP layer adds per-call tool-schema and
   round-trip overhead on every action.
3. The agent already holds the right primitives. Authoring a template is writing a `.ts`
   file; testing it is running `tdk test`. Those are file and shell operations the host
   agent performs natively.
4. Single source of truth. The skill mirrors the docs, so the human and agent surfaces do
   not drift; one set of examples serves both.
5. Portability. A markdown skill works with any agent that can load skills or context. It
   does not bind TDK to MCP-capable hosts.

## Alternatives considered

- An MCP server as the primary surface — rejected for the current need: infra and token
  cost with no capability the agent lacks. Revisit only if a real capability needs a
  server, for example brokered access to a live catalog the agent cannot reach directly.
- A bespoke agent SDK or wrapper — rejected. Heavier than a skill, another package to
  version, and still no capability gain over driving the CLI directly.
- No agent surface, humans only — rejected. Agent-authoring is a stated goal, and a
  markdown skill is nearly free to provide.

## Consequences

- The agent path is `SKILL.md` plus the normal CLI and API; there is nothing to deploy or
  operate.
- The skill carries a doc-maintenance obligation, not an infra one: as the twin of the
  docs, it must be kept in lockstep with the API and examples.
- This declines an MCP server as the default surface; it does not forbid one. A server
  could be added later as a complement to the skill if a real need appears.
