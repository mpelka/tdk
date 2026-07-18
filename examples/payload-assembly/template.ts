// EXAMPLE — "Order Ticket Builder (v2)": the payload-assembly (jsonata block) stress
// test, authored the AUTHORING-V2 way (ADR-0025).
//
// The SAME behaviour as the phase-3a payload-assembly, now a dataflow graph:
//   - FIELDS are module-scope consts (`p.choice` is the enum sugar).
//   - `build-ticket` is a `derive` carrying ONE block-bodied lambda (`assembleTicket`
//     in ./ticket.ts) that returns an OBJECT — so this example uniquely exercises an
//     object-returning derive and its typed SUB-REFS (`ticket.summary`), a corner the
//     flagship's scalar derives don't reach.
//   - `log-line` is a second derive that consumes `ticket.summary` (a sub-ref handle)
//     — a derive→derive→effect chain, all auto-wired, no `${{ steps[...] }}` string.
//   - `log-ticket` is the terminal EFFECT (the side-effectful log), consuming the log
//     line by handle. `output` reads a field by ref.
//
// The one block lambda still exercises every jsonata corner (see ./ticket.ts): the
// `$assert` guard, a nested-lambda map reducing to a scalar, `|| 0` value-defaulting,
// a fee fold, a spread-merged `meta`, and the lenient `parseInt` shim. The tests prove
// the transpiled expression agrees with the hand-written gold value-for-value AND
// throw-for-throw, and the payload-equivalence test proves the v2 rewrite preserves
// the v1 payloads.

import { defineTemplate, derive, effect, p, page } from "@tdk/core";
import { assembleTicket } from "./ticket.ts";

// --- Fields (module-scope consts) -----------------------------------------------
export const customerName = p.string({ title: "Customer name", required: true });
// The value type parameter makes `items` (and the fixture `items`) typed as an array
// of line-item objects (the default `p.array` would infer `string[]`).
export const items = p.array<{ sku: string; qty: number; options: string[]; unitPrice?: number }>({
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
});
export const priority = p.choice(["low", "normal", "high"], { title: "Priority", required: true });
export const discountCode = p.string({ title: "Discount code" });

// --- Derived values -------------------------------------------------------------
// The ticket assembler — an OBJECT-returning derive. Its `inputs` object IS the
// lambda's context, so `assembleTicket` needs no `data:` map and no hand-written Ctx.
export const ticket = derive("build-ticket", { customerName, items, priority, discountCode }, assembleTicket, {
  name: "Build the order ticket",
});

// A display line from the ticket's `summary` SUB-REF (`ticket.summary` renders
// `${{ steps['build-ticket'].output.result.summary }}`) — proving object sub-refs
// chain derive→derive.
export const logLine = derive("log-line", { summary: ticket.summary }, (i) => `Ticket: ${i.summary}`);

// --- The effect (the terminal side-effect) --------------------------------------
// A debug log of the assembled ticket. In a real project this is where a pack's
// effect helper (e.g. `recordTicket(...)`) would go; here the log is the effect.
export const logTicket = effect("log-ticket", "debug:log", {
  name: "Log the assembled ticket",
  input: { message: logLine },
});

export const OrderTicketBuilder = defineTemplate({
  id: "order-ticket-builder",
  title: "Order Ticket Builder",
  description: "Assemble an order ticket from the submitted line items.",
  type: "service",
  tags: ["bakery", "order", "ticket"],
  owner: "team-bakery",
  // One page — the table of contents; ui:order is inferred from source order.
  pages: [page("Order", { customerName, items, priority, discountCode })],
  // The effect is the reachability root; both derives are pulled in through it.
  effects: [logTicket],
  output: { customer: customerName.ref },
});
