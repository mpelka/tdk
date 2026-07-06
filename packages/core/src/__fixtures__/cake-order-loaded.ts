// The functional load() showcase — TDK's `generateStaticParams`.
//
// `load({ env })` fetches the bakery's live menu at COMPILE time; because it is
// env-aware, the nonprod and prod YAML bake DIFFERENT flavour/size options.
// `parameters(data)` turns the loaded menu into real `p.enum` options; `steps`
// and `output` are unchanged (they act on `f`, what the user selected, not on the
// loaded data). `load` is a named export too — discoverable + importable by tests.

import { defineTemplate, type LoadContext, p, page, step } from "../index.ts";
import { bakery } from "./bakery-menu.ts";

export const load = async ({ env }: LoadContext) => ({
  flavors: await bakery.flavors(env),
  sizes: await bakery.sizes(env),
});

export const cakeOrderLoaded = defineTemplate({
  id: "cake-order-loaded",
  title: "Cake Order (loaded)",
  description: "Order a cake; flavours + sizes come from the live bakery menu.",
  type: "service",
  load,
  // `data` is INFERRED as { flavors: string[]; sizes: string[] } (Awaited<load>).
  parameters: (data) => [
    page("Cake", {
      flavor: p.enum(data.flavors, { title: "Flavour", required: true }),
      size: p.enum(data.sizes, { title: "Size", required: true }),
    }),
  ],
  steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor, size: f.size } })],
  output: (f) => ({ flavour: f.flavor, size: f.size }),
});
