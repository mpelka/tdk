# 3. The compile verb is `compile`, not `synth`

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

> *Errata (2026-07-02): this ADR's "Rationale" cites the root script `bun run compile`.
> That script has since been retired — the CLI's whole-config build is now `tdk build`
> (commit 1b4e8ce). The decision (verb = `compile`) stands; only the invocation changed.*

## Context

TDK is positioned as "cdk8s for Backstage templates," and cdk8s names its core
operation **`synth`** (synthesize). Inheriting that word is the path of least
resistance — but TDK performs transformations at **three distinct levels**, and each
needs its own unambiguous verb. On top of that, `synth` collides audibly and
visually with the unrelated word **`synthetic`**, which the project leans on heavily:
every fixture and example uses the **synthetic** cake-order / bakery theme, and
push-safety is described in terms of "synthetic-only" content.

## Decision

The template-level transform is **`compile`**: `compile(template, target) → YAML`
(plus `compileResolved` / `compileAll` for the async paths). Around it, a coherent
three-verb vocabulary, one verb per level:

- **transpile** — expression level: `jsonata()` (TS→JSONata), `nj()` (TS→Nunjucks).
- **compile** — template level: `compile(template, target)` → Scaffolder YAML.
- **execute** — scenario level: `execute(template, fixture)` simulates one run.

The word **`synthetic`** (synthetic fixtures, the synthetic cake/bakery theme) is
unrelated to the verb and must **not** be renamed.

## Rationale

1. **"compile" reads clearer to the audience.** Engineers already hold the model
   "compile = source → a lower-level artifact," which is exactly what
   `TypeScript → template YAML` is. "synth" is cdk-specific jargon that has to be
   explained before it means anything.

2. **One verb per level keeps prose unambiguous.** "Transpile the expression,
   compile the template, execute the scenario" names three different operations
   without overloading a single word. A blanket "synth everything" would blur the
   levels that TDK deliberately keeps distinct.

3. **It avoids the `synth` / `synthetic` collision.** Push-safety relies on the word
   "synthetic" (synthetic-only fixtures, the synthetic theme). A `synth` verb sitting
   next to "synthetic fixtures" invites misreads and trips up any grep or lint that
   scans for the safety vocabulary. Keeping the verb as `compile` leaves "synthetic"
   free and unambiguous.

4. **It matches the surface authors actually touch.** The root script is
   `bun run compile`; the CLI reads as `tdk compile`. One word spans API, CLI, and
   docs.

## Consequences

- The public API is `compile` / `compileResolved` / `compileAll` — never `synth*`.
- Readers arriving from cdk8s must mentally map **synth → compile**; the docs note
  the lineage once so the rename isn't surprising.
- "synthetic" stays reserved for the fixture/theme vocabulary; the leak-scan and
  push-safety wording don't have to fight the verb for the word.

## Alternatives considered

- **`synth` (cdk8s parity)** — rejected: jargon plus the "synthetic" collision.
  Naming parity with cdk8s is not worth the clarity cost.
- **`render`** — rejected: overloaded (rjsf *renders* a form; Nunjucks *renders* a
  string) and it implies producing final UI rather than an intermediate artifact.
- **`build`** — rejected: already taken by the internal `Template.build()` (which
  returns the step list) and overloaded with bundler "build."
