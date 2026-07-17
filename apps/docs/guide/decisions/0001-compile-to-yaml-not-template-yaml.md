# 1. Compile to YAML artifacts, do not template YAML

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

TDK is a TypeScript DSL that compiles to Backstage Scaffolder YAML, the cdk8s model.
Two other shapes were on the table: templating the YAML with a text templating
language, or authoring the YAML by hand.

## Decision

Author templates as typed TypeScript and compile them to YAML. The compiled YAML
stays a reviewable, version-controlled artifact. The DSL sits upstream of the
artifact; it is not a new runtime in the path to Backstage.

## Alternatives considered

- Templating YAML with a text templating language — rejected. A text templating layer
  cannot type-check a step input against a parameter, so you lose types, tests and
  refactoring across a whole template.
- Authoring the YAML by hand — rejected for the same reason: no types, no tests, no
  cross-template refactoring.

## Consequences

- You get types, tests and refactoring across a whole template, and one source that
  compiles to a separate artifact per environment.
- Adopting TDK changes nothing about how a template reaches Backstage: you still commit
  YAML and Backstage still reads it.
- The compiled YAML remains reviewable and version-controlled, so a recompile shows up
  as a diff you can read.
