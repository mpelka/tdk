# Cookbook

One recipe per pattern in the `examples/` package. Each example is a testable,
bakery-themed template that stresses one hard corner of TDK. For each recipe: the
problem it solves, an excerpt adapted from the example, and what to read in the
directory.

The flagship `examples/oven-support-v2` shows the whole v2 shape end to end; the other
examples each isolate one feature. Run the whole suite with `bun test examples/` and
`tdk test examples`.

## The v2 shape end to end

The problem: you want to read a whole template as intent, not as a wire-format
execution plan. `examples/oven-support-v2` authors an oven-support request as a dataflow
graph — module-scope fields, computed derives, one effect, pages and handle-based output
— exactly the way [Author a template](/guide/authoring) describes.

```ts
// Fields — each a const, conditional ones carry their own visibility.
const severity = p.choice({ low: "Low", normal: "Normal", urgent: "Urgent" }, { title: "Severity", required: true });
const problemArea = p.choice(["heating", "conveyor", "controls", "other"], { title: "Problem area", required: true });
const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));

// A derive — a computed value; the conditional input types as `string | undefined`.
const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);

// The effect — a pack helper returning a typed handle, read by the output.
const ticket = raiseTicket("open-oven-ticket", { summary: problemSummary, severity });
```

What to read: `template.ts` for the full graph, `plugin.ts` for the effect-helper
pattern (the `EffectInputValue` args, the registered `execute()` simulator),
`gold-standard.yaml` for the hand-written oracle, and `template.test.ts` for the
differential (each derive's transpiled JSONata against the gold) plus the effect-mocking
contrast (a fixture mock wins over the pack simulator).

## Conditional forms

The problem: a Scaffolder form reveals extra fields as the user chooses, and the reveal
rules stack — a wedding order reveals a topper option, and ticking the topper reveals its
text field. TDK compiles that into the right nested JSON-Schema `dependencies` tree from
per-field predicates.

`examples/conditional-forms/template.ts` puts three conditional mechanisms on distinct
controllers. The `showWhen` chain nests two levels deep, authored with the typed
condition markers (the controllers are hoisted to consts so the editor literal-checks
each value):

```ts
const orderType = p.choice(["standard", "custom", "wedding"], { title: "Order type", required: true });
const topper = p.boolean({ title: "Add a cake topper?" }).showWhen(orderType.is("wedding"));
const topperText = p.string({ title: "Topper text", required: true })
  .showWhen(all(orderType.is("wedding"), topper.is(true)));
```

Naming both controllers in `topperText`'s `showWhen` with `all(...)` is what makes it
nest inside the wedding branch's `topper` node — a genuine two-level chain, not a flat
sibling. `any(...)` and `.in([...])` handle same-field ORs.

What to read: the example's second page uses the object form of `page(...)` to carry a
`dep.when` (packaging reveals ribbon colour) and a `rawDependencies` passthrough (a
verbatim JSON-Schema gate on rush) beside each other — the [v1 primitive
layer](/guide/authoring#compatibility-the-v1-primitive-layer) escape hatches for branch
shapes `showWhen` can't express. The third page reuses a shared fragment.
`gold-standard.yaml` is the hand-authored oracle the tests compare against.

## Computed values from a block body

The problem: a value is assembled from the submitted line items — with a guard, per-item
computation, a fee fold and a merged metadata object. This is procedural logic, so it
needs a block-bodied lambda.

In v2 you name that value with a `derive` and write the block body as its lambda. The
lambda transpiles through the same TS→JSONata transpiler a standalone `jsonata()` uses,
so a guard becomes `$assert`, an intermediate `const` becomes `$x :=`:

```ts
type Item = { sku: string; qty: number; unitPrice: number };
const customerName = p.string({ title: "Customer", required: true });
const items = p.array<Item>({ title: "Line items" });

const ticketPayload = derive("build-ticket", { customerName, items }, (i) => {
  require(i.customerName !== "", "customerName is required");   // → $assert(…)
  const lineItems = i.items.map((item) => ({
    sku: item.sku,
    lineTotal: (item.unitPrice || 0) * item.qty,   // || 0 value-defaulting
  }));
  return { customer: i.customerName, lineItems };
});
```

`examples/payload-assembly/` keeps the same block body as a standalone `jsonata<Ctx>`
expression in `ticket.ts`, fed to a `roadiehq:utils:jsonata` step — the primitive a
`derive` generates for you. Read it for a nested-lambda map reducing to a scalar, a
spread-merged `meta` where later keys win, and `parseInt` via the lenient shim. See the
[expression support reference](/reference/expression-support) for why each holds.

## Fallback chains

The problem: several inputs each fill a gap with a sensible fallback — a requested slot
defaults to next-available, a missing contact falls back to the fetched baker, and each
shape (null-aware `??`, fallback-then-method, comparison ternary) needs the right
Nunjucks. Author them as `nj` and let the transpiler emit each one.

`examples/fallback-chains/template.ts` has one `nj` per input:

```ts
input: {
  // NULL-AWARE ??: null/absent → the fallback; a present value (incl. "") stays.
  slot: nj((c: NotifierCtx) => c.parameters.requestedSlot ?? "next-available"),
  // Fallback-then-method: a named contact wins and is upper-cased; a missing
  // one falls back to the fetched baker name, then upper-cased.
  recipient: nj((c: NotifierCtx) =>
    (c.parameters.contactName || c.steps["fetch-baker"].output.name).toUpperCase(),
  ),
  tier: nj((c: NotifierCtx) => (c.parameters.urgency >= 3 ? "URGENT" : "standard")),
},
```

The `??` vs `||` distinction is the key one. `??` fires on null and absent but lets `""`
through; `||` also collapses `""` and `0`. The scenarios cover present / `""` / null /
absent so all three outcomes are pinned.

What to read: the fixtures cover each fallback branch; `gold-standard.yaml` hand-writes
the equivalent Nunjucks, and the tests render both sides with the real nunjucks engine
and assert value-equivalence.

## Environment-loaded data

The problem: the form's options come from an environment-aware source at compile time,
and a prod-only value must never leak into the test artifact. `load()` bakes the data per
environment, and `env.pick` selects per-environment values — with the leak check
enforcing safety. A `load()` template pairs `load` with the `parameters: (data) => [...]`
form, so the form sees the loaded options.

`examples/env-loaded/template.ts` loads an env-aware menu, then builds the choice options
from it:

```ts
export const load = async ({ env }: LoadContext) => ({
  flavours: await menuClient.flavours(env),
});

export const SeasonalMenuPublisher = defineTemplate({
  id: "seasonal-menu-publisher", title: "Publish the seasonal menu", type: "service",
  lifecycle: { state: "beta", restrictedToUsers: ["baker-042"] },
  load,
  parameters: (data) => [
    page("Menu", {
      featuredFlavour: p.choice(data.flavours, { title: "Featured flavour", required: true }),
      headline: p.string({ title: "Storefront headline", required: true }),
    }),
  ],
  steps: (f) => [
    step("publish", "bakery:publish-menu", {
      input: {
        featuredFlavour: f.featuredFlavour,
        cluster: env.pick({ test: "test-oven", prod: "prod-oven" }),
      },
    }),
  ],
});
```

The test menu has two flavours; the prod menu adds a prod-only `pistachio-royale` that
must appear only in the prod artifact. Because it uses `load()`, this template compiles
via the async path.

What to read: there are two golds, `gold-standard.nonprod.yaml` and
`gold-standard.prod.yaml`. The tests compile both targets (via `compileResolved` and
`compileAll`) and diff each against its gold, proving the prod-only value never reaches
test. See [the environment model](/guide/concepts#the-environment-model).

## Real network data

The problem: the form's options come from a live HTTP catalog, and the loader must be
testable without ever hitting the internet. `load()` does a real `fetch`, and the base
URL is injectable so a test can redirect it to a local mock.

`examples/api-loaded/template.ts` fetches an env-specific catalog and bakes it into the
choice options:

```ts
function menuApiBaseUrl(): string {
  return process.env.BAKERY_MENU_API ?? "https://menu.bakery.example";
}

export const load = async ({ env }: LoadContext) => {
  const response = await fetch(`${menuApiBaseUrl()}/api/${env}/flavours`);
  if (!response.ok) throw new Error(`menu catalog fetch failed: ${response.status}`);
  const { flavours } = (await response.json()) as { flavours: string[] };
  return { flavours };
};
```

The example carries the whole testing recipe. Scenario snapshots inject `loaded: {…}`, so
`tdk test` never fetches; a separate test in `template.test.ts` spins a local
`Bun.serve` catalog on an ephemeral port, points `BAKERY_MENU_API` at it, and runs the
real `load()` for both envs — proving the fetch path bakes different options per env with
no real network and no extra dependency.

What to read: `template.test.ts` for the two tiers side by side, and
`__fixtures__/mock-catalog.ts` for the local server the mock-server tier (and the
`tdk test` preflight) share. See [testing a real load()](/guide/testing#testing-a-real-load).

## Plugin composition

The problem: a template needs a custom field, a custom action that `execute()` can
simulate, and a value resolved at compile time — all from an outside plugin, without core
importing that plugin. This is the three extension hooks composed. A pack packages a
side-effect action as an **effect helper** (see the flagship recipe above); the same
`defineField` / `defineAction` / `defineResolver` hooks power it.

`examples/plugin-composed/template.ts` imports a small inline plugin and uses all three
hooks:

```ts
import { cakePicker, headBakerOf, provisionOven } from "./plugin.ts";

export const OvenProvisioner = defineTemplate({
  id: "oven-provisioner", title: "Provision an oven", type: "service",
  parameters: {
    station: p.choice(["pastry", "bread"], { title: "Station", required: true }),
    capacity: p.number({ title: "Capacity (trays)", required: true }),
    ovenModel: cakePicker({ catalog: "bakery/oven-models", default: "deck-3000", title: "Oven model", required: true }),
  },
  steps: (f) => [
    provisionOven({ id: "provision", station: f.station, capacity: f.capacity, model: f.ovenModel, if: headBakerOf("pastry") }),
    step("record", "debug:log", { input: { headBaker: headBakerOf("pastry"), ovenId: nj((c) => c.steps.provision.output.ovenId) } }),
  ],
});
```

`cakePicker` is a field (hook B), `provisionOven` is an action with a `simulate` (hooks B
and C), and `headBakerOf("pastry")` is a resolver marker (hook A) used both as a step
input and in a step `if:`. The resolved id lands in the artifact; the marker never does.
Because it uses a resolver marker, this template compiles via the async path.

What to read: `plugin.ts` defines the three hooks against the public barrel only — never
core internals — which is what makes "core never imports a plugin" real. See
[Extend TDK](/guide/extending) for the hooks themselves, and the flagship `plugin.ts` for
the effect-helper variant.
