# 8. Scenario snapshots are the regression baseline, and a mock beats a simulator

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

Scenario tests need a regression baseline, and within a fixture two sources can supply a
step's output: an explicit step mock the author wrote, or a registered action
simulator. One has to win.

## Decision

Treat the committed `__snapshots__/` files, checked by `tdk test --ci` in CI, as the
regression baseline. Within a fixture, an explicit step mock wins over a registered
action simulator.

## Alternatives considered

- Letting the simulator win over an explicit mock — rejected. The mock is the author's
  intent for this one scenario; the simulator is the general model of how an action
  behaves. Specific beats general.

## Consequences

- A mock is the only way to exercise an error shape a simulator will not produce — a
  rejected payload, a partial output — so pinning a step's output regardless of the
  simulator has to be possible.
- See [mock-wins precedence](/guide/testing#mock-wins-precedence).
