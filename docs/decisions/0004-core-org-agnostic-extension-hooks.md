# 4. Core stays org-agnostic; org specifics plug in via extension hooks

- **Status:** Accepted — backfilled 2026-06-29; records a decision settled early in
  development.

## Context

TDK grew up against real templates that carried org-specific shapes: a mandatory
Business-Justification page, employee- and entity-picker fields, directory-group
lookups, and a house catalog of custom step actions. The tempting move is to ship
those in `@tdk/core` so every team gets them for free. Two forces push the other
way:

1. **Push-safety.** This repo is pushable and must contain **zero real-org tokens** —
   not even anonymized ones. Anything concrete and org-shaped is a leak risk by
   construction.
2. **Coupling and bloat.** Baking one org's nouns into core marries the kit to that
   org forever and grows a surface that has to move every time the org's conventions
   change.

## Decision

`@tdk/core` ships **mechanisms only**, never org **instances**.

- **Mechanisms in core:**
  - `defineResolver(name, fn)` — async value resolvers; a marker (e.g.
    `person("…")`) is replaced with a concrete value during
    `compileResolved` / `compileAll`.
  - `defineField` / `defineAction` — typed field- and step-action sugar that compile
    straight down to `p.customField` / a `Step` (and `defineAction`'s optional
    `simulate` registers the action's `execute()` simulator).
  - the `execute` action-simulator hook (`registerActionSimulator`).
  - the generic `fragment()` composition helper and the `p.customField` escape hatch.
- **Concrete instances live in the consumer's own repo:** a Business-Justification
  page fragment, employee/entity pickers, the org's resolvers and actions — all built
  **on top of** those hooks, in the (un-pushed) consumer code, **not** in core. This
  is **enforced by physically moving** any concrete org artifact out of core; the
  only org-shaped thing that may stay is a **synthetic** exemplar
  (`packages/core/src/__fixtures__/plugin-bakery`, which composes all three hooks).

## Rationale

1. **Push-safety becomes structural, not vigilance-based.** If core imports no
   concrete org thing, core *cannot* leak one. The architectural boundary and the
   leak boundary are the same line.

2. **The dependency arrow points one way: consumer → core.** Core never imports a
   plugin. A resolver / field / action is registered by the consumer at its own
   startup; core supplies only the registry and the marker mechanism. There is no
   path by which core depends on an org.

3. **One kit, many orgs.** Encoding no org's nouns lets the same `@tdk/core` serve
   any organization. cdk8s ships *constructs*, not your company's clusters — the same
   discipline keeps TDK reusable.

4. **A smaller, calmer core API.** Mechanisms change rarely; org nouns change
   constantly. Keeping the nouns out keeps core's semver quiet and its surface
   learnable.

5. **The escape hatches make consumer-side concreteness ergonomic.** `fragment()`
   plus `p.customField` give a consumer a typed, intent-revealing way to build the
   concrete thing — `bakingJustificationPage()` is just a `fragment(...)` in the
   consumer repo — without core ever knowing it exists.

## Consequences

- `packages/core/src/__fixtures__/plugin-bakery` is the synthetic exemplar that wires
  all three hooks; it is a fixture, not shipped org content.
- The real (anonymized) templates and the org plugin live only in the un-pushed
  sibling repo, so core stays publishable.
- A consumer pays a one-time wiring cost per org: register its resolvers/actions and
  publish its fields/fragments before authoring.
- New org needs are met by new **consumer-side** plugins, not by core PRs — which
  keeps core's release cadence decoupled from any org's churn.

## Alternatives considered

- **Ship org instances in core** (or an `@tdk/org-*` package in this repo) —
  rejected: breaks push-safety, couples the kit to one org, and bloats the surface.
- **A registry baked into core, "filled in" by data files** — still drags org nouns
  into the tree, so the same leak surface remains. Rejected.
- **Per-org forks of core** — rejected: defeats the purpose of a shared kit and
  multiplies maintenance.
