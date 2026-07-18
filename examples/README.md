# `@tdk/examples` — the gold-standard example suite

Six **testable templates**, each a worked reference for one hard corner of TDK.
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

## The six templates

| Dir | Template | What it stresses |
|---|---|---|
| `conditional-forms` | Custom Cake Order Wizard | Conditional forms: a two-level `showWhen` chain (wedding → `topper` → `topperText` **nests inside** the wedding branch), `dep.when` and a `rawDependencies` passthrough coexisting on **distinct** controllers, and a shared page **fragment**. |
| `payload-assembly` | Order Ticket Builder | One block-bodied `jsonata`: `$assert` guard, a **nested-lambda** map reducing to a scalar, `\|\| 0` **value** defaulting, a scalar fee fold, a spread-merged `meta` (later keys win), and `parseInt` via the lenient shim. |
| `fallback-chains` | Delivery Slot Notifier | `nj` fallbacks: the null-aware `??` (null/absent → fallback, `""` passes through — three distinct outcomes), a fallback-then-method `(a \|\| b).toUpperCase()` (a **named** value isn't overwritten), a template literal + number, a comparison ternary, and a `.split("-")[0]` passthrough. |
| `env-loaded` | Seasonal Menu Publisher | Compile-time data + env safety: `load()` bakes an **env-aware** menu (prod-only flavour never leaks into test), `env.pick` per-env cluster, a `beta` lifecycle emitting `restrictedToUsers`, and an `extraSpec` passthrough. **Two golds** (nonprod/prod); tests compile both targets via `compileResolved` + `compileAll`. |
| `plugin-composed` | Oven Provisioner | All three extension hooks via an **inline** plugin: a `defineField` picker, a `defineAction` with a `simulate`, and a `defineResolver` marker (used as a step input **and** in a step `if:`). The resolved value lands in the artifact; the marker never does; `execute()` gets simulator-computed outputs. |
| `oven-support` | Oven Support Request | `derive(...)` dataflow (ADR-0025): five derived values compiling to `roadiehq:utils:jsonata` steps, **topologically interleaved** with two manual steps (the SSA chain lookup → derive → register), auto-wired `${{ steps['…'].output.result }}` references, an output-only derive, and a **conditional** field (`showWhen`) typed `T \| undefined` in a derive. Adds a **byte-equivalence** check against hand-written roadie steps, beside the value-equivalent gold. |

## Running

```sh
bun test examples/                       # the tests (structure + differentials)
bun run apps/cli/src/cli.ts test examples        # the scenario snapshots
bun run apps/cli/src/cli.ts test examples --ci   # snapshots, fail on any drift
```

Each template's `template.test.ts` is the place to read for HOW a feature is
pinned; each `gold-standard.yaml` is the place to read for WHAT the compiler must
produce.
