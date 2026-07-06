// The functional ("Option C") authoring of a synthetic cake-order template:
// COLOCATED params (declared inside each `page(title, props)`) + an INFERRED,
// typed field-ref map `f` handed to `steps`/`output`.
//
// `cake-order-fn.test.ts` pins the entity it compiles to and its execute output.
// This file is the ergonomics showcase — note that no param is named twice and
// `f.flavor` etc. are fully typed (see the `@ts-expect-error` proof in the test).

import { defineTemplate, p, page, step } from "../index.ts";

export const cakeOrderFn = defineTemplate({
  id: "cake-order",
  title: "Cake Order",
  description: "Order a cake from a partner bakery.",
  type: "service",
  tags: ["cake", "order", "bakery"],
  owner: "team-bakery",
  extraSpec: {
    catalog_metadata: { category: "Catering", lead_time_days: "3" },
  },
  parameters: [
    page("Cake", {
      flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
      size: p.enum(["Small", "Large"], { title: "Size", required: true }),
    }),
    page("Extras", {
      notes: p.string({ title: "Notes", uiWidget: "textarea" }),
    }),
  ],
  // `f` is INFERRED: { flavor: Ref<"Vanilla" | "Chocolate">, size: Ref<"Small" | "Large">, notes: Ref<string> }.
  steps: (f) => [
    step("order", "bakery:place", {
      name: "Place the order",
      input: { flavor: f.flavor, size: f.size, notes: f.notes },
    }),
  ],
  output: (f) => ({ flavour: f.flavor, size: f.size }),
});
