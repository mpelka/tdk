# 4. Differential testing is the transpiler's trust anchor

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

The transpilers turn a TypeScript lambda into a JSONata or Nunjucks expression. A bug
in that step is the worst kind of bug TDK could have: it would corrupt templates
silently, at scale, with no error anywhere. That risk needs a control strong enough to
trust the transpilers.

## Decision

Check every emitted expression against the author's TypeScript function acting as a
JavaScript oracle. The harnesses live at
`packages/core/src/expr/jsonata/differential.ts` and
`packages/core/src/expr/nunjucks/differential.ts`. Each runs the compiled expression
through the real `jsonata` or `nunjucks` engine and the author's lambda as an oracle,
then compares the two values fixture by fixture. Agreement is throw-aware: two runs
agree when they return deep-equal values or both throw the same message.

## Alternatives considered

- Asserting the emitted string looks right — rejected. It would prove nothing about what
  the expression computes. A string can look correct and still compute the wrong value.

## Consequences

- An emission change cannot merge until it proves it is value-equivalent.
- See [how equivalence is proven](/guide/stability#how-equivalence-is-proven).
