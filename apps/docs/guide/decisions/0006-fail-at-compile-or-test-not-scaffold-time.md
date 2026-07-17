# 6. Move failures from scaffold time to compile or test time

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

Backstage fails at run time, in front of the template's end user, far from the line that
caused it. The alternative on offer is to emit a best-effort artifact and let Backstage
sort it out, which is what raw YAML already does, and it is the problem.

## Decision

Move each failure to the earliest, loudest place it can reach. Several mechanisms carry
this out:

- Compile rejects a JSONata expression used inside a <code v-pre>${{ }}</code>
  interpolation (`rejectJsonataInInterpolation` in `compile.ts`), because such an
  expression would ship as an inert literal string.
- Fixtures can be validated against the compiled schema.
- Parameters carry human-readable error messages.
- An unresolved resolver marker throws in the synchronous compile rather than leaking
  into the artifact.

## Alternatives considered

- Emitting a best-effort artifact and letting Backstage sort it out — rejected. That is
  what raw YAML does, and it puts the failure in front of the end user, far from its
  cause.

## Consequences

- A whole class of mistakes fails at compile or test time instead of scaffold time.
- The full catalogue of compile-time throws is in
  [Core concepts](/guide/concepts#silent-to-loud-why-the-compiler-throws).
