# 2. Functional `defineTemplate` over `class extends Template`

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

## Context

A template is a triple: a `parameters` form, a list of `steps`, and an optional
`output` map. That shape maps naturally onto either of two authoring surfaces:

- a **class** the author subclasses —

  ```ts
  class OrderCake extends Template {
    id = "order-cake";
    params = { flavor: p.enum(["Vanilla", "Chocolate"]) };
    build() {
      return [step("place", "bakery:place", { input: { flavor: this.params.flavor.ref } })];
    }
  }
  ```

- or a **value** the author declares —

  ```ts
  export default defineTemplate({
    id: "order-cake", title: "Order a Cake", type: "service",
    parameters: [page("Cake", { flavor: p.enum(["Vanilla", "Chocolate"]) })],
    steps: (f) => [step("place", "bakery:place", { input: { flavor: f.flavor } })],
  });
  ```

The early prototype used the class. The tension that decided against it is TDK's
central feature: the **typed field-ref map `f`** handed to `steps`/`output`. With a
class, params are instance fields and steps reach them through `this.params.*`;
class-method inference of those dynamically-assigned fields types *worse*, and the
form can't be colocated inside the pages where it renders while still feeding one
flat, precisely-typed map.

## Decision

Author templates as **`defineTemplate({...})` values**, never as
`class … extends Template`:

- params are **colocated** inside each `page(title, { props })` (or a bare props
  object for the single-page form);
- `steps`/`output` are `(f) => …`, where `f` is an **inferred** flat map of every
  param's `.ref`, typed `{ flavor: Ref<"Vanilla" | "Chocolate">, … }`.

`Template` (the class) survives **only as the internal model** that `defineTemplate`
produces and that `compile`/`execute`/`compileAll` consume — it is no longer an
authoring surface. The class-based authoring API was **removed** once every template
had migrated to `defineTemplate`.

## Rationale

1. **Typed `f` inference is strictly better as a function parameter than through
   `this`.** Declaring `defineTemplate`'s parameter with a `const` type parameter
   lets tsc infer the exact page tuple / props' keys-and-types and synthesize
   `f: { flavor: Ref<…>, … }` for `steps`/`output`. A class `build()` reading
   `this.params` can't match that precision — `this`-typing of fields assigned at
   construction degrades, and recovering it means re-declaring field types that
   duplicate the param declarations.

2. **Colocation.** The functional form lets a param live in the page where it
   renders (`page("Cake", { flavor: p.enum(...) })`) while still contributing to one
   flat typed `f`. A class would push every param into a single `params = {}` block
   divorced from page structure, or force a parallel page declaration.

3. **No `this` / `new` / binding hazards.** A `defineTemplate(...)` is just a value
   you `export default`; there is no construction lifecycle, no `this` to bind, no
   subclass contract to satisfy. Composition stays uniform and FP-friendly —
   fragments are functions returning pages, resolvers and fields are values.

4. **A template is data, not behavior.** It is a spec compiled to YAML. A value
   reads as data; a class implies methods, lifecycle, and identity that a spec does
   not have. (This is the same semantic-honesty argument that ADR-0001 makes against
   JSX's component framing.)

## Consequences

- `defineTemplate` returns a `Template` instance, so the entire
  `compile` / `execute` / `compileAll` pipeline — and the CLI's template discovery —
  consume it unchanged. The class did not disappear; it went internal.
- The typed `f` inference is **load-bearing** (shared with ADR-0001): future API
  changes must preserve it.
- Authors never write `class` / `extends` / `new`; the docs and `SKILL.md` show only
  the value form.
- Because the model remains a class internally, advanced machinery (e.g. the
  `prepare()` step that backs `load()` — see ADR-0006) lives on it without leaking
  into the authoring surface.

## Alternatives considered

- **`class … extends Template` authoring** — the original API. Rejected: worse
  inference for `steps`, `this` boilerplate, and no colocation. Removed after the
  migration completed.
- **A fluent builder** (`template().page(...).step(...)`) — chainable, but each
  `.step(...)` can't see the full set of params with precise types, so it loses the
  static `f` map, and it reads worse than a declarative object.
- **Keep both class and functional surfaces** — rejected: two ways to author one
  thing is a docs-and-maintenance tax with no upside once `f` inference made the
  functional form strictly better.
