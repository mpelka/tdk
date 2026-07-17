# 21. Pure-TypeScript authoring, no JSX

- Status: Accepted — 2026-06-28, reaffirming the original project-start decision after
  a deliberate re-evaluation
- Date: relocated into the docs ADR set 2026-07-18

## Context

A template's `parameters` block is a tree of pages and fields with props, structurally
close to JSX:

```tsx
<Template id="cake-order-request" type="service">
  <Page title="Order">
    <Enum name="bakeryCode" options={data.bakeryCodes} title="Bakery" required />
  </Page>
  <BakingJustificationPage />
</Template>
```

So the question recurs: should templates be authored in JSX — a `.tsx` DSL with a custom
`createElement` — instead of the current pure-TypeScript form?

```ts
defineTemplate({
  id: "cake-order-request", type: "service",
  parameters: (data) => [
    page("Order", { bakeryCode: p.enum(data.bakeryCodes, { title: "Bakery", required: true }) }),
    bakingJustificationPage(),
  ],
  steps: (f) => [ step("request", "bake:approve", { input: { bakery: f.bakeryCode } }) ],
});
```

Mechanically, JSX is easy: it is sugar for `createElement(type, props, children)`. A
custom pragma pointing at a TDK factory is the well-trodden cdk8s and hyperscript
pattern, fully supported by tsc and Bun. Feasibility is not the issue; the trade-offs
are.

## Decision

Author templates in pure TypeScript — `defineTemplate(...)` with colocated
`page(title, { name: p.* })` and inferred typed refs. No JSX, no `.tsx`, no JSX pragma in
the toolchain. The reasoning:

1. JSX erases the typed field-ref map `f`, which is TDK's central feature. The colocated
   form keeps each page's params as a typed object (`{ bakeryCode: p.enum(...) }`), which
   is what lets `steps: (f) => …` receive an inferred `{ bakeryCode: Ref<string>, … }`.
   JSX homogenises children into `JSX.Element`; a parent sees `children: Element[]` with
   the per-child name and value-type erased at the type level. The typed ref map cannot
   be recovered from JSX children, so `steps` and `output` lose their typed bridge to the
   form.
2. JSX only covers a third of a template. `parameters` is tree-shaped, but `steps` (an
   action list) and `output` (a map) are not. A JSX form would be stapled to TS steps,
   joined by the exact `f` bridge that JSX breaks.
3. The conditional-rendering ergonomic is a mirage. A Backstage form's conditionals are
   evaluated at form-fill time by RJSF on the user's input, not at compile time.
   `{advanced && <Field/>}` would evaluate at compile time, which is wrong. The
   correct-by-construction form is today's `dep.when` with angle brackets. No gain.
4. It breaks the lightweight Node execution path. The zero-Bun distribution route is
   Node's type-stripping. JSX is a syntax transform, not a type annotation, so
   type-stripping cannot handle it, forcing a full transpile step into the CLI and the
   editor extension.
5. Semantic honesty. `defineTemplate({ parameters: [...] })` reads as data, which it is —
   a spec compiled to YAML. `<Template>` implies a component with render and runtime
   semantics that do not exist.

Rendering the compiled JSON Schema in a live form preview through RJSF is genuinely
React. That renders the output, not the authoring surface, and this decision does not
preclude it.

## Alternatives considered

- JSX form authoring — rejected for the reasons above. Re-evaluated 2026-06-28; the typed
  `f` inference has only become more central since the original decision, which
  strengthens it.
- JSX for structure only, with props staying typed objects — rejected. It yields none of
  JSX's benefit while still adding the toolchain cost.

## Consequences

- Templates stay `.ts`; the toolchain needs no JSX transform; `@tdk/core` stays runnable
  under Node type-stripping.
- The typed `f` inference is load-bearing — future API changes must preserve it. It is
  precisely the thing JSX would have cost. See
  [ADR 22](/guide/decisions/0022-functional-definetemplate-over-class), which shares this
  constraint.
- A future form-preview webview may use React and RJSF independently to render compiled
  schema, without affecting authoring.
