// EXAMPLE 1 — "Custom Cake Order Wizard": the conditional-form stress test.
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

import { all, defineTemplate, dep, nj, p, page, step } from "@tdk/core";
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
  ],
  steps: () => [
    step("log-order", "debug:log", {
      name: "Log the order",
      input: { message: nj((c) => `Order type: ${c.parameters.orderType}`) },
    }),
  ],
  output: (f) => ({ orderType: f.orderType }),
});
