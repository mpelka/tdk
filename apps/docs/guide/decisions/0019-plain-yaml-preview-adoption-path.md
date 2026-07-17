# 19. Plain-YAML preview is the adoption path

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A team weighing TDK has existing plain YAML Scaffolder templates that never adopted the
DSL. Making them commit before they see the payoff is a barrier.

## Decision

Make the form preview and dry-run work on a plain YAML Scaffolder template that never
adopted the DSL. This is deliberate, not a side effect.

## Alternatives considered

- A tool that only worked on `.ts` sources — rejected. It would demand the commitment
  before showing the payoff.

## Consequences

- A team can point the preview and a dry-run at their existing YAML templates with zero
  commitment, then adopt the DSL for the templates where typed authoring pays off.
- See [preview plain YAML templates](/guide/vscode#preview-plain-yaml-templates).
