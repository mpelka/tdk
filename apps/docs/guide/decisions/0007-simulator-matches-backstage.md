# 7. The simulator matches Backstage, even when kinder would be friendlier

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

`execute()` simulates a run of a compiled template. It could be held to behavioural
fidelity with Backstage, or it could be made kinder than production — keep going past a
failure, or treat an empty array as truthy.

## Decision

Hold `execute()` to behavioural fidelity with Backstage. It halts at the first failed
step, and its `if:` truthiness matches Backstage's own `isTruthy`. The halt is faithful
to all three of the ways a step can fail in `execute.ts`: a
`roadiehq:utils:jsonata` expression that throws, an input that fails to render, and a
registered action simulator that throws. Each records the error on its step and halts
the run; every later step is marked not reached, and the template output is undefined.

## Alternatives considered

- A simulator that keeps going past a failure, or treats an empty array as truthy
  because that is friendlier — rejected. A simulator kinder than production teaches wrong
  lessons: a scenario would show a trace that real Backstage never produces, and the
  author would trust it.

## Consequences

- A scenario trace matches what real Backstage would do, failure included.
- See [halt at the first failed step](/guide/testing#halt-at-the-first-failed-step).
