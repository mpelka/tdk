# 6. `load()` shape: env-aware, parameters-only, two mock tiers

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

## Context

Some forms need **live data baked in at compile time**. The list of available cake
flavours, or of partner bakeries, comes from a catalog — not a hand-typed enum. That
data has two properties:

- it **differs per deploy env** (a test catalog vs a prod catalog), and
- it must end up as **real, static options in the emitted YAML**, not a runtime
  fetch.

That raises three questions a data hook has to answer: where does the loaded data
flow, when does the loader run, and how is it mocked in tests **without dragging a
mocking framework into core**?

## Decision

`defineTemplate` accepts an optional **`load`**:

```ts
defineTemplate({
  id: "order-cake", title: "Order a Cake", type: "service",
  load: ({ env }) => fetchFlavours(env),          // compile-time, per env
  parameters: (data) => [                          // load() result feeds parameters ONLY
    page("Cake", { flavor: p.enum(data.flavours, { title: "Flavour", required: true }) }),
  ],
  steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
});
```

- **`load({ env })` runs at compile time**, once per target env, via the async compile
  path (`compileResolved` / `compileAll` / `execute`). The synchronous `compile()`
  **throws** if a template declares `load()`, directing the caller to the async path.
- **Its result feeds `parameters` ONLY.** `parameters` becomes `(data) => form`.
  `steps`/`output` are **unchanged** — still `(f) => …` over the field-ref map —
  because they act on what the **user selected**, not on the loaded data.
- **The loader is memoized per env** (one fetch per template × env) — an
  `unstable_cache`-style seam.
- **Mocking is two-tier, with no separate `mock()` primitive.** Either inject the
  result directly (a fixture's `loaded`, surfaced through `prepare`'s `opts.data`), or
  fake the network with **MSW** so `load` runs for real against faked HTTP. Core stays
  mock-agnostic.

This is TDK's **`generateStaticParams`**: a build-time data hook whose output bakes
into the static artifact.

## Rationale

1. **parameters-only keeps the typed `f` bridge intact.** If loaded data also flowed
   into `steps`/`output`, those signatures would have to mix `f` and `data`,
   complicating the inference that ADR-0001 and ADR-0002 call load-bearing. Steps act
   on user selections; data only shapes the form's *options*. The split is clean by
   design.

2. **Compile-time, not runtime.** Backstage forms want concrete option lists in the
   YAML. Resolving `load()` at compile time produces real, static options **per env**,
   matching Backstage's model and avoiding any runtime dependency in the emitted
   template.

3. **env-aware because the data is env-specific.** `load({ env })` lets the test
   artifact get test-catalog options and the prod artifact get prod ones. It pairs
   with `env.pick` and feeds the same env-safety scan that guards against prod-only
   values leaking into a test artifact.

4. **Two tiers, no new primitive, because the two real testing needs are already
   covered.** A unit/snapshot test injects `loaded` directly — fast, deterministic,
   no network. An integration-flavoured test fakes HTTP with MSW so the *actual*
   `load` code runs. A bespoke `mock()` primitive would be a redundant third way that
   grows the API and couples core to a mocking model it should not own.

5. **Memoization makes `load()` cheap and deterministic per env.** Multiple targets
   sharing an env don't refetch; the per-env cache is the `unstable_cache` analogue.

## Consequences

- A template with `load()` **must** be compiled via the async path; the synchronous
  `compile()` throws a clear error pointing to `compileResolved` / `compileAll` /
  `execute`.
- `load` itself stays plain and unmocked — the *test* chooses a tier around it.
- Core ships **no** mocking dependency; MSW (or direct injection) lives in the
  consumer's test setup.
- `steps`/`output` authors never see loaded data. If a step needs a loaded value, it
  must surface through a **param** (the form) — which is the intended discipline.

## Alternatives considered

- **Let `load` data flow into `steps`/`output` too** — rejected: it muddies the `f`
  inference and blurs "form options" against "user selections."
- **A dedicated `mock()` primitive in core** — rejected: redundant with the two
  existing tiers and couples core to one mock model.
- **Runtime data fetching (Backstage fetches options live)** — rejected: not TDK's
  job (TDK emits static YAML), env-fragile, and outside the compile-time model.
- **A non-memoized loader** — rejected: refetches per target, nondeterministic
  ordering, slower.
