# 2. The three-verb vocabulary, and compile not synth

- Status: Accepted
- Date: recorded retrospectively 2026-07-18

## Context

TDK transforms source at three distinct levels, and each level needs its own
unambiguous verb. cdk8s names its core operation synth, and inheriting that word is
the path of least resistance. But synth also collides with synthetic, the word the
project leans on for its fixtures and its cake-order theme.

## Decision

Split the vocabulary into three verbs, one per level:

- transpile at the expression level (`jsonata()` and `nj()`)
- compile at the template level (`compile(template, target)` to YAML)
- execute for a simulated run (`execute(template, fixture)`)

Use compile, not synth, for the template-level step. Keep the word synthetic reserved
for the fixture and theme vocabulary; it must never be renamed.

## Alternatives considered

- synth, for cdk8s parity — rejected. It reads as a cdk8s term of art that has to be
  explained, and it sits one letter away from synthetic, which invites misreads and
  trips up any scan for the push-safety vocabulary.
- render — rejected. Overloaded: RJSF renders a form and Nunjucks renders a string, and
  the word implies producing final UI rather than an intermediate artifact.
- build — rejected. Already taken by `tdk build` and by the internal `Template.build()`,
  which returns the step list, and overloaded with bundler build.

## Consequences

- The docs and the code never blur an expression-level change with a template-level
  one, because each has its own verb.
- A reader arriving from cdk8s maps synth to compile once; the lineage is noted so the
  rename is not a surprise.
- The full rule, including the reserved word synthetic, lives in the contributor
  guide's vocabulary section.
