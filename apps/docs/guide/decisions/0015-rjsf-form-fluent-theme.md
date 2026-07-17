# 15. RJSF for the form, Fluent for the theme

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The form preview renders a compiled JSON Schema. Two things need deciding: the form
engine, and how to theme it. Behavioural fidelity to Backstage matters; visual fidelity
to Backstage does not.

## Decision

Use RJSF for the form, and theme it with Fluent UI rather than Backstage's MUI.

## Alternatives considered

- Reimplementing the form engine — rejected. RJSF is Backstage's own form engine, so its
  `dependencies` and `oneOf` semantics, required handling, ajv validation and `ui:schema`
  behaviour come for free and stay honest. A reimplementation would diverge silently as
  Backstage evolved.
- Theming with Backstage's MUI — rejected. The preview should look native to VS Code and
  follow the editor theme, so the Fluent theme fits better.

## Consequences

- The form behaves as Backstage's does, because it is the same engine.
- The preview looks native to the editor rather than to Backstage.
