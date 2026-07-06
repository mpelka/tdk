// Expression fixtures for TDK's own tests.
//
// Small, synthetic `jsonata(...)` instances that exercise the transpiler +
// differential harness without depending on the example apps. Keep them minimal
// but representative of the behaviours the tests assert.

import { jsonata } from "../index.ts";

/** The JSONata root-context shape the order-ticket fixture reads from. */
export type TicketCtx = {
  parameters: {
    cakeName: string;
    owner: { members: { email: string }[] };
    tags: string[];
  };
};

/**
 * A "massive object-literal with logic" payload builder. Exercises object
 * literals, nested objects, template literals, a ternary, `.length`,
 * `.map().join()`, and a param-array passthrough — the differential showcase.
 */
export const orderTicket = jsonata<TicketCtx>((c) => ({
  summary: `New order: ${c.parameters.cakeName}`,
  project: { key: "BAKERY" },
  description:
    c.parameters.owner.members.length > 0
      ? `Owned by ${c.parameters.owner.members.map((m) => m.email).join(", ")}`
      : "Unassigned",
  labels: c.parameters.tags,
}));
