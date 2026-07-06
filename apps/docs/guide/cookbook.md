# Cookbook

Six recipes, one per pattern in the `examples/` package. Each example is a
testable, bakery-themed template that stresses one hard corner of TDK. For each
recipe: the problem it solves, a real excerpt from the example, and what to read in
the directory.

Every code excerpt below is lifted from the actual `examples/*/template.ts`. Run the
whole suite with `bun test examples/` and `tdk test examples`.

## Conditional forms

The problem: a Scaffolder form reveals extra fields as the user chooses, and the
reveal rules stack — a wedding order reveals a topper option, and ticking the topper
reveals its text field. TDK compiles that into the right nested JSON-Schema
`dependencies` tree.

`examples/conditional-forms/template.ts` puts three conditional mechanisms on
distinct controllers. The `showWhen` chain nests two levels deep, authored with the
typed condition markers (the controllers are hoisted to consts so the editor
literal-checks each value):

```ts
const orderType = p.enum(["standard", "custom", "wedding"], { title: "Order type", required: true });
const topper = p.boolean({ title: "Add a cake topper?", showWhen: orderType.is("wedding") });

page("Order Type", {
  orderType,
  tiers: p.number({ title: "Number of tiers", showWhen: orderType.is("wedding") }),
  topper,
  topperText: p.string({ title: "Topper text", showWhen: all(orderType.is("wedding"), topper.is(true)) }),
}),
```

Naming both controllers in `topperText`'s `showWhen` with `all(...)` is what makes it
nest inside the wedding branch's `topper` node — a genuine two-level chain, not a flat
sibling.

What to read: the second page uses the object form of `page(...)` to carry a
`dep.when` (packaging reveals ribbon colour) and a `rawDependencies` passthrough (a
verbatim JSON-Schema gate on rush) beside each other. The third page reuses a shared
fragment. `gold-standard.yaml` is the hand-authored oracle the tests compare against.

## Payload assembly

The problem: a `roadiehq:utils:jsonata` step assembles a structured payload from the
submitted line items — with a guard, per-item computation, a fee fold and a merged
metadata object. This is procedural logic, so it needs a block-bodied `jsonata`.

`examples/payload-assembly/` keeps the expression in its own module,
`ticket.ts`, so both the template and the tests import the same expression object.
The block body runs a guard, then binds intermediate variables:

```ts
export const ticketPayload = jsonata<TicketCtx>((c) => {
  // Guard: a ticket must name its customer, else abort the run (→ $assert).
  assert(c.customerName !== "", "customerName is required");

  const lineItems = c.items.map((item) => ({
    sku: item.sku,
    qty: item.qty,
    unitPrice: item.unitPrice || 0,
    label: item.options.map((o) => o).join(", "),
    lineTotal: (item.unitPrice || 0) * item.qty,
  }));
  // ...fee fold, spread-merged meta, parseInt shim...
});
```

The template feeds it the roadie `data` map with `nj` (every value a
<code v-pre>${{ … }}</code> template) and passes the expression as `expression:
ticketPayload.jsonata`:

```ts
step("build-ticket", "roadiehq:utils:jsonata", {
  input: {
    data: {
      customerName: nj((c) => c.parameters.customerName),
      items: nj((c) => c.parameters.items),
      priority: nj((c) => c.parameters.priority),
      discountCode: nj((c) => c.parameters.discountCode),
    },
    expression: ticketPayload.jsonata,
  },
}),
```

What to read: `ticket.ts` exercises a nested-lambda map that reduces to a scalar
(the agreeing case for nested maps), `|| 0` value defaulting, a spread-merged `meta`
where later keys win, and `parseInt` via the lenient shim. See the
[expression support reference](/reference/expression-support) for why each holds.

## Fallback chains

The problem: several step inputs each fill a gap with a sensible fallback — a
requested slot defaults to next-available, a missing contact falls back to the
fetched baker, and each shape (null-aware `??`, fallback-then-method, comparison
ternary) needs the right Nunjucks. Author them as `nj` and let the transpiler emit
each one.

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
  banner: nj((c: NotifierCtx) => `Delivery slot — urgency ${c.parameters.urgency}`),
  tier: nj((c: NotifierCtx) => (c.parameters.urgency >= 3 ? "URGENT" : "standard")),
  region: nj((c: NotifierCtx) => c.steps["fetch-baker"].output.name.split("-")[0]),
},
```

The `??` vs `||` distinction is the key one. `??` fires on null and absent but lets
`""` through; `||` also collapses `""` and `0`. The scenarios cover present / `""` /
null / absent so all three outcomes are pinned.

What to read: the fixtures cover each fallback branch; `gold-standard.yaml`
hand-writes the equivalent Nunjucks, and the tests render both sides with the real
nunjucks engine and assert value-equivalence.

## Environment-loaded data

The problem: the form's options come from an environment-aware source at compile
time, and a prod-only value must never leak into the test artifact. `load()` bakes
the data per environment, and `env.pick` selects per-environment values — with the
leak check enforcing safety.

`examples/env-loaded/template.ts` loads an env-aware menu, then builds the enum
options from it:

```ts
export const load = async ({ env }: LoadContext) => ({
  flavours: await menuClient.flavours(env),
});

export const SeasonalMenuPublisher = defineTemplate({
  // ...
  lifecycle: { state: "beta", restrictedToUsers: ["baker-042"] },
  extraSpec: {
    bakery_catalogue_metadata: { category_L1: "Signature Bakes", refresh_cadence: "weekly" },
  },
  load,
  parameters: (data) => [
    page("Menu", {
      featuredFlavour: p.enum(data.flavours, { title: "Featured flavour", required: true }),
      headline: p.string({ title: "Storefront headline", required: true }),
    }),
  ],
  steps: (f) => [
    step("publish", "bakery:publish-menu", {
      input: {
        featuredFlavour: f.featuredFlavour,
        headline: f.headline,
        cluster: env.pick({ test: "test-oven", prod: "prod-oven" }),
      },
    }),
  ],
  // ...
});
```

The test menu has two flavours; the prod menu adds a prod-only `pistachio-royale`
that must appear only in the prod artifact. Because it uses `load()`, this template
compiles via the async path.

What to read: there are two golds, `gold-standard.nonprod.yaml` and
`gold-standard.prod.yaml`. The tests compile both targets (via `compileResolved` and
`compileAll`) and diff each against its gold, proving the prod-only value never
reaches test. See [the environment model](/guide/concepts#the-environment-model).

## Real network data

The problem: the form's options come from a live HTTP catalog, and the loader must be
testable without ever hitting the internet. `load()` does a real `fetch`, and the base
URL is injectable so a test can redirect it to a local mock.

`examples/api-loaded/template.ts` fetches an env-specific catalog and bakes it into the
enum:

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

The example carries the whole testing recipe. Scenario snapshots inject `loaded: {…}`,
so `tdk test` never fetches; a separate test in `template.test.ts` spins a local
`Bun.serve` catalog on an ephemeral port, points `BAKERY_MENU_API` at it, and runs the
real `load()` for both envs — proving the fetch path bakes different options per env
with no real network and no extra dependency.

What to read: `template.test.ts` for the two tiers side by side, and
`__fixtures__/mock-catalog.ts` for the local server the mock-server tier (and the
`tdk test` preflight) share. See [testing a real load()](/guide/testing#testing-a-real-load).

## Plugin composition

The problem: a template needs a custom field, a custom action that `execute()` can
simulate, and a value resolved at compile time — all from an outside plugin, without
core importing that plugin. This is the three extension hooks composed.

`examples/plugin-composed/template.ts` imports a small inline plugin and uses all
three hooks:

```ts
import { cakePicker, headBakerOf, provisionOven } from "./plugin.ts";

export const OvenProvisioner = defineTemplate({
  // ...
  parameters: {
    station: p.enum(["pastry", "bread"], { title: "Station", required: true }),
    capacity: p.number({ title: "Capacity (trays)", required: true }),
    ovenModel: cakePicker({ catalog: "bakery/oven-models", default: "deck-3000", title: "Oven model", required: true }),
  },
  steps: (f) => [
    provisionOven({
      id: "provision",
      station: f.station,
      capacity: f.capacity,
      model: f.ovenModel,
      if: headBakerOf("pastry"),
    }),
    step("record", "debug:log", {
      input: {
        headBaker: headBakerOf("pastry"),
        ovenId: nj((c) => c.steps.provision.output.ovenId),
      },
    }),
  ],
  // ...
});
```

`cakePicker` is a field (hook B), `provisionOven` is an action with a `simulate`
(hooks B and C), and `headBakerOf("pastry")` is a resolver marker (hook A) used both
as a step input and in a step `if:`. The resolved id lands in the artifact; the
marker never does. Because it uses a resolver marker, this template compiles via the
async path.

What to read: `plugin.ts` defines the three hooks against the public barrel only —
never core internals — which is what makes "core never imports a plugin" real. See
[Extend TDK](/guide/extending) for the hooks themselves.
