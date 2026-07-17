# 22. Functional defineTemplate over class extends Template

- Status: Accepted — backfilled 2026-06-29, recording a decision settled early in
  development
- Date: relocated into the docs ADR set 2026-07-18

## Context

A template is a triple: a `parameters` form, a list of `steps`, and an optional `output`
map. That shape maps onto either of two authoring surfaces — a class the author
subclasses, or a value the author declares:

```ts
class OrderCake extends Template {
  id = "order-cake";
  params = { flavor: p.enum(["Vanilla", "Chocolate"]) };
  build() {
    return [step("place", "bakery:place", { input: { flavor: this.params.flavor.ref } })];
  }
}
```

```ts
export default defineTemplate({
  id: "order-cake", title: "Order a Cake", type: "service",
  parameters: [page("Cake", { flavor: p.enum(["Vanilla", "Chocolate"]) })],
  steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
});
```

The early prototype used the class. The tension that decided against it is TDK's central
feature: the typed field-ref map `f` handed to `steps` and `output`. With a class, params
are instance fields reached through `this.params.*`; class-method inference of those
dynamically-assigned fields types worse, and the form cannot be colocated inside the
pages where it renders while still feeding one flat, precisely-typed map.

## Decision

Author templates as `defineTemplate({...})` values, never as `class … extends Template`:

- params are colocated inside each `page(title, { props })`, or a bare props object for a
  single-page form
- `steps` and `output` are `(f) => …`, where `f` is an inferred flat map of every param's
  `.ref`, typed `{ flavor: Ref<"Vanilla" | "Chocolate">, … }`

The reasoning:

1. Typed `f` inference is strictly better as a function parameter than through `this`.
   Declaring `defineTemplate`'s parameter with a `const` type parameter lets tsc infer
   the exact page tuple and props, then synthesise `f` for `steps` and `output`. A class
   `build()` reading `this.params` cannot match that precision.
2. Colocation. The functional form lets a param live in the page where it renders while
   still contributing to one flat typed `f`. A class would push every param into a single
   `params = {}` block divorced from page structure.
3. No `this`, `new` or binding hazards. A `defineTemplate(...)` is a value you
   `export default`; there is no construction lifecycle and no subclass contract to
   satisfy. Composition stays uniform and FP-friendly — fragments are functions returning
   pages; resolvers and fields are values.
4. A template is data, not behaviour. A value reads as data; a class implies methods,
   lifecycle and identity that a spec does not have. This is the same semantic-honesty
   argument that [ADR 21](/guide/decisions/0021-pure-typescript-authoring-no-jsx) makes
   against JSX's component framing.

`Template`, the class, survives only as the internal model that `defineTemplate` produces
and that `compile`, `execute` and `compileAll` consume. It is no longer an authoring
surface. The class-based authoring API was removed once every template had migrated to
`defineTemplate`.

## Alternatives considered

- `class … extends Template` authoring — the original API. Rejected: worse inference for
  `steps`, `this` boilerplate, and no colocation.
- A fluent builder (`template().page(...).step(...)`) — rejected. Each `.step(...)` cannot
  see the full set of params with precise types, so it loses the static `f` map, and it
  reads worse than a declarative object.
- Keeping both class and functional surfaces — rejected. Two ways to author one thing is a
  docs-and-maintenance tax with no upside once `f` inference made the functional form
  strictly better.

## Consequences

- `defineTemplate` returns a `Template` instance, so the whole `compile`, `execute` and
  `compileAll` pipeline — and the CLI's template discovery — consume it unchanged. The
  class did not disappear; it went internal.
- The typed `f` inference is load-bearing, shared with
  [ADR 21](/guide/decisions/0021-pure-typescript-authoring-no-jsx): future API changes
  must preserve it.
- Authors never write `class`, `extends` or `new`; the docs and `SKILL.md` show only the
  value form.
- Because the model stays a class internally, advanced machinery such as the `prepare()`
  step that backs `load()` — see
  [ADR 24](/guide/decisions/0024-load-shape-env-aware-parameters-only) — lives on it
  without leaking into the authoring surface.
