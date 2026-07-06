// EXAMPLE 3 — "Delivery Slot Notifier": the nj (Nunjucks) fallback-chain stress test.
//
// Every step input is an `nj(...)` expression exercising a different fallback /
// method / comparison shape inside a Scaffolder `${{ … }}`:
//   - `c.requestedSlot ?? "next-available"` — the NULL-AWARE `??` (fires on null AND
//     absent, but NOT on ""); scenarios cover present / "" / null / absent, giving
//     three distinct documented outcomes (invariant a).
//   - `(c.contactName || steps["fetch-baker"].output.name).toUpperCase()` — a
//     fallback-then-method: the `|| ` picks the first truthy base, then `| upper`.
//     A NAMED contact renders unchanged; only a MISSING one falls back to the baker
//     (invariant b — the #17 war-story).
//   - `` `Slot for ${c.urgency}...` `` — a template literal mixing text + a number.
//   - `c.urgency >= 3 ? "URGENT" : "standard"` — a comparison ternary (nj supports
//     `(a if c else b)`, so no two-step `if:` workaround is needed).
//   - `steps["fetch-baker"].output.name.split("-")[0]` — a verbatim method-call
//     passthrough (`.split(...)[0]`).
//
// The gold-standard.yaml hand-writes the equivalent Nunjucks; the tests render both
// sides with the real nunjucks engine and assert value-equivalence across scenarios.

import { defineTemplate, nj, p, step } from "@tdk/core";

/** The run context these nj expressions read (`c`). */
export interface NotifierCtx {
  parameters: { requestedSlot?: string | null; contactName?: string | null; urgency: number };
  steps: Record<string, { output: { name: string } }>;
}

export const DeliverySlotNotifier = defineTemplate({
  id: "delivery-slot-notifier",
  title: "Delivery Slot Notifier",
  description: "Notify a baker of a delivery slot, filling gaps with sensible fallbacks.",
  type: "service",
  tags: ["bakery", "delivery", "notify"],
  owner: "team-bakery",
  parameters: {
    requestedSlot: p.string({ title: "Requested slot" }),
    contactName: p.string({ title: "Contact name" }),
    urgency: p.number({ title: "Urgency (1–5)", required: true }),
  },
  steps: () => [
    // An external lookup (mocked in scenarios) that returns the assigned baker,
    // e.g. `{ name: "north-riverside-bakery" }`.
    step("fetch-baker", "http:backstage:request", {
      name: "Fetch the assigned baker",
      input: { path: "/api/bakery/assignment" },
    }),
    step("notify", "debug:log", {
      name: "Compose the notification",
      input: {
        // NULL-AWARE ??: null/absent → the fallback; a present value (incl. "") stays.
        slot: nj((c: NotifierCtx) => c.parameters.requestedSlot ?? "next-available"),
        // Fallback-then-method: a named contact wins and is upper-cased; a missing
        // one falls back to the fetched baker name, then upper-cased.
        recipient: nj((c: NotifierCtx) =>
          (c.parameters.contactName || c.steps["fetch-baker"].output.name).toUpperCase(),
        ),
        // Template literal mixing text + a number.
        banner: nj((c: NotifierCtx) => `Delivery slot — urgency ${c.parameters.urgency}`),
        // Comparison ternary.
        tier: nj((c: NotifierCtx) => (c.parameters.urgency >= 3 ? "URGENT" : "standard")),
        // Method-call passthrough: the region prefix of the baker's slug.
        region: nj((c: NotifierCtx) => c.steps["fetch-baker"].output.name.split("-")[0]),
      },
    }),
  ],
});
