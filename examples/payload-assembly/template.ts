// EXAMPLE 2 — "Order Ticket Builder": the payload-assembly (jsonata block) stress
// test.
//
// Two steps:
//   (i)  a `roadiehq:utils:jsonata` step whose `data` is built with `nj` (every
//        field a `${{ … }}` Scaffolder template, resolved BEFORE the expression
//        runs) and whose `expression` is ONE block-bodied `jsonata` — the ticket
//        assembler in `./ticket.ts`. Read `data` fields BARE inside the expression
//        (its root IS the data map): `c.customerName` compiles to `customerName`.
//   (ii) a `debug:log` step that consumes step (i)'s output via `nj`
//        (`c.steps["build-ticket"].output.result.summary` — note the `.output`).
//
// The gold-standard.yaml hand-writes the equivalent JSONata + step shapes; the tests
// prove the compiled expression agrees with the gold's, value-for-value AND
// throw-for-throw (the $assert edge), across fixtures.

import { defineTemplate, nj, p, step } from "@tdk/core";
import { ticketPayload } from "./ticket.ts";

export const OrderTicketBuilder = defineTemplate({
  id: "order-ticket-builder",
  title: "Order Ticket Builder",
  description: "Assemble an order ticket from the submitted line items.",
  type: "service",
  tags: ["bakery", "order", "ticket"],
  owner: "team-bakery",
  parameters: {
    customerName: p.string({ title: "Customer name", required: true }),
    // The value type parameter makes `f.items` / the fixture `items` typed as an
    // array of line-item objects (the default `p.array` would infer `string[]`).
    items: p.array<{ sku: string; qty: number; options: string[]; unitPrice?: number }>({
      title: "Line items",
      // Each item: a sku, a quantity, a list of options, and an optional price.
      items: {
        type: "object",
        properties: {
          sku: { type: "string" },
          qty: { type: "number" },
          options: { type: "array", items: { type: "string" } },
          unitPrice: { type: "number" },
        },
      },
    }),
    priority: p.enum(["low", "normal", "high"], { title: "Priority", required: true }),
    discountCode: p.string({ title: "Discount code" }),
  },
  steps: () => [
    step("build-ticket", "roadiehq:utils:jsonata", {
      name: "Build the order ticket",
      input: {
        // `data` values are ALWAYS `nj` — each is a Scaffolder template resolved
        // before the expression runs. A `jsonata(...)` dropped here would ship as
        // an inert literal string.
        data: {
          customerName: nj((c) => c.parameters.customerName),
          items: nj((c) => c.parameters.items),
          priority: nj((c) => c.parameters.priority),
          discountCode: nj((c) => c.parameters.discountCode),
        },
        // The top-level `expression` IS the JSONata — the one block body.
        expression: ticketPayload.jsonata,
      },
    }),
    step("log-ticket", "debug:log", {
      name: "Log the assembled ticket",
      input: {
        // Consume the previous step's output — note the `.output.result` path
        // (roadie wraps the expression's value in `{ result }`).
        message: nj((c) => `Ticket: ${c.steps["build-ticket"].output.result.summary}`),
      },
    }),
  ],
  output: (f) => ({ customer: f.customerName }),
});
