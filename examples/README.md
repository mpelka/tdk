# `@tdk/examples` — the gold-standard example suite

Eight **testable templates**, each a worked reference for one hard corner of TDK.
Every template dir holds:

- `template.ts` — the template (bakery-themed; zero real-org tokens),
- `gold-standard.yaml` — a **hand-written oracle**: what a Backstage expert would
  author for the same behaviour, written **before** the template was compiled,
- `__fixtures__/scenarios.ts` — 3+ `execute()` scenarios,
- `template.test.ts` — the tests,
- `__snapshots__/scenarios.snap` — the committed scenario snapshots.

## The oracle discipline

Each `gold-standard.yaml` is authored **by hand from the behavioural spec, never
regenerated from compiled output**. The tests compare compile-vs-gold by
**value-equivalence** (the JSONata/Nunjucks differential harnesses,
`assertExecuteAgainstGold`, structural asserts) — **never byte-equality**. The
hand formatting differs from the pretty-printer on purpose: a byte-identical gold
would prove circularity, not correctness. When the two disagree, one side has a
real bug (see `payload-assembly` below).

## Authoring v1 vs v2

The suite spans both authoring surfaces (ADR-0025). Authoring **v2** — module-scope
fields, `p.choice`, composed `.showWhen`, `derive`, an `effects:` list, pages-as-TOC
and handle-based `output` — is the idiom to copy; **v1** stays represented on purpose,
as the compatibility surface and for shapes v2 does not (yet) replace.

| Dir | Surface | What it stresses |
|---|---|---|
| `oven-support-v2` | **v2** (flagship) | The full v2 surface end to end: module-scope fields, three `derive`s, one `effect` (a pack helper), pages-as-TOC with inferred `ui:order`, and handle-based `output`. The canonical idiom. |
| `payload-assembly` | **v2** | One block-bodied jsonata as an OBJECT-returning `derive` (uniquely exercising object sub-refs, `ticket.summary`): a `$assert` guard, a nested-lambda map reducing to a scalar, `\|\| 0` value defaulting, a fee fold, a spread-merged `meta`, and `parseInt` via the lenient shim. A derive→derive→effect chain. |
| `fallback-chains` | **v2** | `nj` fallbacks as EFFECT inputs (v2 doesn't force everything into a `derive`): the null-aware `??`, a fallback-then-method, a template literal, a comparison ternary, and a `.split("-")[0]` passthrough — two effects ordered by a data reference, no hard chain. |
| `plugin-composed` | **v2** | All three extension hooks composed with the v2 effect surface: a `defineField` picker (module-scope), a `defineAction` step wrapped by `rawEffect` (preserving the resolver `if:`), and a `defineResolver` marker used in the `if:` and an effect input. The oven id is read by handle. |
| `conditional-forms` | **v1** (keeper) | Conditional forms: a two-level `showWhen` chain, `dep.when` and a `rawDependencies` passthrough on **distinct** controllers, and a shared page **fragment** — the v1-only shapes v2 does not replace. Page 4 shows the same synthesis authored the v2 way. |
| `oven-support` | **v1** (pair) | The BEFORE half of the before/after pair with `oven-support-v2`: the same `derive` dataflow on the v1 template surface (a manual `steps:` list, functional `output`). Read the two side by side. |
| `env-loaded` | **v1** (load) | Compile-time data + env safety: `load()` bakes an **env-aware** menu, `env.pick` per-env cluster, a `beta` lifecycle, and an `extraSpec` passthrough. **Two golds** (nonprod/prod). Stays v1 — the v2 config has no `load()` hook. |
| `api-loaded` | **v1** (load) | A REAL network `load()` (`fetch`) baked into the form, tested two ways (fixture-injected `loaded:` and a local `Bun.serve` mock). Stays v1 for the same `load()` reason as env-loaded. |

## Payload-equivalence (the phase-4 migration proof)

The three v2-migrated dirs (`payload-assembly`, `fallback-chains`, `plugin-composed`)
each carry a permanent behaviour-preservation proof:

- `__baseline__/payloads.json` — the **payload digest** captured from the v1 template
  **before** the rewrite (the template `output` + each effect's fully-rendered
  input/output, keyed by action; jsonata/derive steps dropped as topology — see
  `payload-oracle.ts`),
- `payload-equivalence.test.ts` — asserts the v2 template reproduces that digest
  scenario-for-scenario.

The digest ignores step ids, order, and expression layout on purpose: the v2 rewrite
is free to reshape topology, but the final payloads must not move.

## Running

```sh
bun test examples/                       # the tests (structure + differentials + payload-equivalence)
bun run apps/cli/src/cli.ts test examples        # the scenario snapshots
bun run apps/cli/src/cli.ts test examples --ci   # snapshots, fail on any drift
```

Each template's `template.test.ts` is the place to read for HOW a feature is
pinned; each `gold-standard.yaml` is the place to read for WHAT the compiler must
produce.
