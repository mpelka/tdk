// EXAMPLE 1 — "Custom Cake Order Wizard": the conditional-form stress test.
//
// ⚠️ DELIBERATELY V1 (authoring-v1). This is the fleet's compatibility-surface keeper
// (ADR-0025 phase 4, #19): it is authored the v1 way ON PURPOSE, because it exercises
// the v1-ONLY conditional-form shapes that authoring-v2 does NOT replace —
// `dep.when(...)`, a `rawDependencies` JSON-Schema passthrough, and the OBJECT form of
// `page({ title, properties, dependencies, rawDependencies })` (which the colocated
// `page(title, props)` map form the v2 `pages:` list takes cannot carry). Page 4 shows
// the SAME synthesis authored the v2 way (the `.showWhen(...)` method + `all`/`any`),
// so the file is itself a v1-vs-v2 comparison. The v2 form surface is demonstrated in
// oven-support-v2; the effects/derive surface in the migrated payload-assembly,
// fallback-chains and plugin-composed examples. Migrating this one would delete the
// only coverage of the v1 shapes above, so it stays — see AGENTS.md on old primitives
// remaining until a pre-1.0 removal.
//
// This template exercises every way TDK reveals a field conditionally, all on ONE
// page, and proves they coexist on DISTINCT controllers:
//
//   - `showWhen` chains (page 1) — `tiers` + `topper` appear only for a wedding;
//     `topperText` appears only when `topper` is checked. Because `topper` is itself
//     conditional (shown for a wedding), `topperText` AUTO-NESTS inside `topper`'s
//     branch, which is inside the wedding branch — a genuine TWO-LEVEL chain
//     (invariant a). A `showWhen` controller must be a field on the SAME page, so
//     `orderType` and every field it reveals share page 1.
//   - `dep.when` (page 2) — the `packaging` controller reveals `ribbonColor` on
//     "ribbon". Driven by a DISTINCT controller from the showWhen chain, so both
//     trees compile independently.
//   - `rawDependencies` (page 2) — a verbatim JSON-Schema passthrough on `rush`,
//     emitted next to the compiled dep.when tree untouched (invariant c).
//   - the COMPOSED form (page 4) — the SAME synthesis authored ADR-0025's way: the
//     `.showWhen(...)` METHOD, an `all(...)` AND-chain that auto-nests, an `any(...)`
//     same-field OR, and the `.in([...])` array form. No hand-written `dep.*`.
//
// Page 3 reuses a shared "Baker Notes" page FRAGMENT (authored once, imported here).
//
// Page 2 uses the OBJECT form of `page(...)` because it carries `dependencies`
// (dep.when) and `rawDependencies` beside its `properties` — settings the colocated
// `page(title, props)` form does not take. Its fields therefore aren't in the typed
// `f` map, which is fine: `steps`/`output` here reference only `f.orderType` (page 1).
//
// The gold-standard.yaml is the hand-authored oracle; template.test.ts asserts the
// compiled entity agrees with it value-for-value.

import { all, any, defineTemplate, dep, nj, p, page, step } from "@tdk/core";
import { bakerNotesPage } from "./fragments.ts";

// Page-1 CONTROLLERS hoisted to consts so the conditional fields can name them with
// the typed `showWhen` form — `orderType.is("wedding")` is literal-checked by the
// editor (a mistyped value squiggles), where the record `{ orderType: "wedding" }`
// only fails at compile. `orderType` is a p.enum, so its literals are captured.
const orderType = p.enum(["standard", "custom", "wedding"], {
  title: "Order type",
  required: true,
});
// `topper` is BOTH a conditional field (revealed for a wedding) and the controller
// for `topperText` — hoisted so `topperText` can name it. Declared after `orderType`
// so its own `showWhen` can reference it.
const topper = p.boolean({ title: "Add a cake topper?", showWhen: orderType.is("wedding") });

// Page-2 params declared up top so the `dep.when` controller (`packaging`) can be
// referenced both as a property and inside the page's `dependencies`.
const packaging = p.enum(["box", "ribbon"], { title: "Packaging" });
const ribbonColor = p.string({ title: "Ribbon colour" });
const rush = p.boolean({ title: "Rush order?" });

// Page-4 CONTROLLERS + composed-form conditional fields — the SAME synthesis as
// page 1, but authored with ADR-0025 Decision 1's surface: the `.showWhen(...)`
// METHOD (not the option), the `any(...)` same-field OR, and the `.in([...])`
// array form. Two INDEPENDENT discriminators live on one page:
//   - `deliveryMethod` reveals `courierSpeed` for a courier; `insurance` is
//     revealed by an `all(...)` AND-chain (courier AND express), so it AUTO-NESTS
//     inside `courierSpeed`'s express branch — a two-level chain like page 1's.
//   - `contactPref` reveals `mobile` via `any(...)` (an OR over sms/call, i.e.
//     `contactPref.in(["sms", "call"])`) and `notifyEmail` via `.in([...])`. Both
//     name the SAME controller, so they GROUP into one dependency with a field
//     per matching branch.
const deliveryMethod = p.enum(["collection", "courier"], { title: "Delivery method" });
const courierSpeed = p.enum(["standard", "express"], { title: "Courier speed" }).showWhen(deliveryMethod.is("courier"));
const insurance = p
  .boolean({ title: "Insure the delivery?" })
  .showWhen(all(deliveryMethod.is("courier"), courierSpeed.is("express")));
const contactPref = p.enum(["sms", "email", "call"], { title: "Contact preference" });
const mobile = p.string({ title: "Mobile number" }).showWhen(any(contactPref.is("sms"), contactPref.is("call")));
const notifyEmail = p.string({ title: "Notification email" }).showWhen(contactPref.in(["email", "sms"]));

export const CustomCakeOrderWizard = defineTemplate({
  id: "custom-cake-order-wizard",
  title: "Custom Cake Order Wizard",
  description: "Order a bespoke cake — the form reveals extra fields as you choose.",
  type: "service",
  tags: ["cake", "order", "bakery", "wizard"],
  owner: "team-bakery",
  parameters: [
    // --- Page 1: the order type + the wedding showWhen chain (same-page controller) ---
    page("Order Type", {
      orderType,
      // showWhen fields, all controlled by fields on THIS page, authored with the
      // typed markers (`orderType.is(...)`/`topper.is(...)`):
      //   `tiers`/`topper` revealed for a wedding; `topperText` revealed when the
      //   order is a wedding AND `topper` is checked. Naming BOTH controllers with
      //   `all(...)` is what makes `topperText` nest INSIDE the wedding branch's
      //   `topper` node (two-level chain, invariant a) rather than sit as a flat
      //   sibling — a single `topper.is(true)` would compile `topper` as a
      //   page-level dependency, flattening the tree.
      tiers: p.number({ title: "Number of tiers", showWhen: orderType.is("wedding") }),
      topper,
      topperText: p.string({ title: "Topper text", showWhen: all(orderType.is("wedding"), topper.is(true)) }),
    }),

    // --- Page 2: packaging (dep.when) + rush (rawDependencies), distinct controllers ---
    page({
      title: "Packaging & Speed",
      properties: {
        // dep.when controller — a base field; its reveal is authored below.
        packaging,
        // rawDependencies controller — a base field; its reveal is verbatim below.
        rush,
      },
      // dep.when(packaging): reveal `ribbonColor` on the ribbon branch.
      dependencies: [dep.when(packaging, [dep.eq("box"), dep.eq("ribbon", { properties: { ribbonColor } })])],
      // rawDependencies: a hand-written JSON-Schema dependency on `rush`, passed
      // through VERBATIM (TDK never re-shapes it) beside the compiled ones.
      rawDependencies: {
        rush: {
          oneOf: [
            { properties: { rush: { const: false } } },
            {
              properties: {
                rush: { const: true },
                rushJustification: { type: "string", title: "Why is this order urgent?" },
              },
            },
          ],
        },
      },
    }),

    // --- Page 3: the shared fragment, used verbatim ---
    bakerNotesPage(),

    // --- Page 4: the COMPOSED form — same synthesis, authored the v2 way ---
    // Every conditional field here uses the `.showWhen(...)` METHOD; the two
    // discriminators compile to two independent dependency trees (like page 2's),
    // and `mobile`/`notifyEmail` group under `contactPref` (like page 1's chain
    // groups under `orderType`). No `dep.*` in sight — the compiler synthesises it.
    page("Delivery", {
      deliveryMethod,
      courierSpeed,
      insurance,
      contactPref,
      mobile,
      notifyEmail,
    }),
  ],
  steps: () => [
    step("log-order", "debug:log", {
      name: "Log the order",
      input: { message: nj((c) => `Order type: ${c.parameters.orderType}`) },
    }),
  ],
  output: (f) => ({ orderType: f.orderType }),
});
