# 1. Pure-TypeScript authoring (no JSX)

- **Status:** Accepted — 2026-06-28. Reaffirms the original project-start decision
  after a deliberate re-evaluation.

*(examples re-themed to the synthetic bakery fixture set, 2026-07)*

## Context

A TDK template's `parameters` block is a tree of pages and fields with props —
structurally very close to JSX:

```tsx
<Template id="cake-order-request" type="service">
  <Page title="Order">
    <Enum name="bakeryCode" options={data.bakeryCodes} title="Bakery" required />
  </Page>
  <BakingJustificationPage />
</Template>
```

So the question recurs: should templates be authored in **JSX** (a `.tsx` DSL with
a custom `createElement`) instead of the current pure-TypeScript form?

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

Mechanically, JSX is easy: it is sugar for `createElement(type, props, children)`.
A custom pragma (`jsxImportSource`) pointing at a TDK factory that builds the same
internal page/param model is the well-trodden cdk8s / hyperscript pattern, fully
supported by tsc and Bun. **Feasibility is not the issue; the trade-offs are.**

## Decision

Author templates in **pure TypeScript** — `defineTemplate(...)` with colocated
`page(title, { name: p.* })` and inferred typed refs. **No JSX**, no `.tsx`, no JSX
pragma in the toolchain.

## Rationale

1. **JSX erases the typed field-ref map `f` — TDK's central feature.** The
   colocated form keeps each page's params as a typed _object_
   (`{ bakeryCode: p.enum(...) }`), which is what lets `steps: (f) => …` receive an
   inferred `{ bakeryCode: Ref<string>, … }`. JSX homogenizes children into
   `JSX.Element`; a parent sees `children: Element[]` with the per-child name and
   value-type **erased at the type level**. The typed ref map cannot be recovered
   from JSX children, so `steps`/`output` lose their typed bridge to the form. This
   inferred form→steps bridge is the very reason TDK chose functional-over-class
   authoring; JSX would trade it away.

2. **JSX only covers a third of a template.** `parameters` is tree-shaped, but
   `steps` (an action list) and `output` (a map) are not. A JSX form would be
   stapled to TS steps, joined by the exact `f` bridge that JSX breaks.

3. **The conditional-rendering ergonomic is a mirage.** A Backstage form's
   conditionals are evaluated at _form-fill time_ by rjsf on the user's input — not
   at compile time. `{advanced && <Field/>}` would evaluate at compile time, which
   is wrong. The correct-by-construction form is `<When field="x" eq="y">…</When>`,
   i.e. today's `dep.when` with angle brackets. No gain.

4. **It breaks the lightweight Node execution path.** The zero-Bun distribution
   route is Node's type-stripping (strip type annotations, run `.ts` directly). JSX
   is a _syntax transform_, not a type annotation; type-stripping won't handle it,
   forcing a full transpile step (esbuild/swc) into the CLI and the editor
   extension. A concrete regression against a stated distribution goal.

5. **Semantic honesty.** `defineTemplate({ parameters: [...] })` reads as _data_ —
   which it is (a spec compiled to YAML). `<Template>` implies a component with
   render/runtime semantics that do not exist (there is no React runtime; the
   output is YAML).

6. **The composition win JSX is loved for, TDK already has.** Fragments are
   page-components: `bakingJustificationPage()` is component-style reuse, as a
   value, with no JSX.

## Where React *does* belong

Rendering the **compiled JSON Schema** in a live form-preview (the parked
three-column `TS | YAML | form` webview) through rjsf is genuinely React. That is
rendering the _output_, not authoring in JSX — a separate, valid use that this
decision does not preclude.

## Consequences

- Templates stay `.ts`; the toolchain needs no JSX transform; `@tdk/core` stays
  runnable under Node type-stripping.
- The typed `f` inference is **load-bearing** — future API changes must preserve it
  (it is precisely the thing JSX would have cost).
- A future form-preview webview may use React/rjsf independently to render compiled
  schema, without affecting authoring.

## Alternatives considered

- **JSX form authoring** — rejected for the reasons above. Re-evaluated 2026-06-28;
  the typed-`f` inference has only become more central since the original decision,
  which strengthens it.
- **JSX for structure only (props stay typed objects)** — yields none of JSX's
  benefit (fields remain a props object) while still adding the toolchain cost.
  Pointless.
