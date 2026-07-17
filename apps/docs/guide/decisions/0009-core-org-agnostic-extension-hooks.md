# 9. Extension points keep core org-agnostic

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

An organisation's templates carry org-specific shapes: their own fields, actions and
directory lookups. The tempting move is to build those into `@tdk/core` so every team
gets them for free. That would tie TDK's release cadence to one organisation's schema
and make the repo carry organisation-specific shapes.

## Decision

Extend core through `defineResolver`, `defineField`, `defineAction` and
`registerActionSimulator`, and let core never import a plugin. TDK ships the contract
types; an organisation's field and action pack lives in that organisation's own repo.

## Alternatives considered

- Building an organisation's fields and actions into core — rejected. It would couple
  TDK to one organisation's schema and grow a surface that has to move whenever that
  organisation's conventions change.

## Consequences

- Keeping the plugin seam one-directional lets each organisation's pack evolve on its
  own cadence while TDK stays org-agnostic.
- The only org-shaped thing that stays in core is a synthetic exemplar,
  `packages/core/src/__fixtures__/plugin-bakery`, which composes all three hooks.
- See [Extend TDK](/guide/extending) for the hooks.
