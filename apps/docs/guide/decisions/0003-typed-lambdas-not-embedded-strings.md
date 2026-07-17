# 3. Typed lambdas transpiled to JSONata and Nunjucks, not embedded strings

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

A template's expressions could be authored two ways: as typed TypeScript lambdas that
`jsonata()` and `nj()` transpile to JSONata and Nunjucks, or as embedded JSONata and
Nunjucks strings, the way a raw template does.

## Decision

Author expressions as typed TypeScript lambdas. The transpilers turn them into JSONata
and Nunjucks. Nobody hand-writes either language.

## Alternatives considered

- Embedded JSONata and Nunjucks strings — rejected. A hand-written string is unchecked.
  It can name a parameter that does not exist, or one that has been renamed, and nothing
  catches it until Backstage fails at scaffold time.

## Consequences

- A lambda is type-checked against the template's parameters and steps, so a typo or a
  rename fails at compile time, not at scaffold time.
- See [Write expressions](/guide/expressions) for the transpilers, and the
  [expression support reference](/reference/expression-support) for what each maps.
