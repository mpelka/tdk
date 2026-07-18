// EXAMPLE — "Delivery Slot Notifier (v2)": the nj (Nunjucks) fallback-chain stress
// test, authored the AUTHORING-V2 way (ADR-0025).
//
// The SAME behaviour as the phase-3a fallback-chains, now a dataflow graph — and the
// example that proves NOT everything becomes a `derive`/handle. `nj(...)` fallback
// expressions (null-aware `??`, fallback-then-method, comparison ternaries, method
// passthroughs) are Nunjucks, so they stay INLINE EFFECT INPUTS; `derive` is jsonata
// and cannot host them. What v2 changes here:
//   - FIELDS are module-scope consts across a pages-as-TOC form.
//   - the two side-effectful steps are EFFECTS: `fetch-baker` (an http request) and
//     `notify` (the notification). `fetch-baker` uses a BUILTIN Backstage action, so
//     it is authored with core's `effect(...)` directly — a pack helper is for a
//     pack's OWN custom actions, not `http:backstage:request`.
//   - the planner orders `fetch-baker` before `notify` from the DATA reference the
//     notify expressions make to its output (no hard step chain).
//
// Every notify input is an `nj(...)` expression exercising a different shape (see each
// comment). The gold-standard.yaml hand-writes the equivalent Nunjucks; the tests
// render both sides with the real nunjucks engine and assert value-equivalence, and
// the payload-equivalence test proves the v2 rewrite preserves the v1 payloads.

import { defineTemplate, effect, nj, p, page } from "@tdk/core";

/** The run context these nj expressions read (`c`). */
export interface NotifierCtx {
  parameters: { requestedSlot?: string | null; contactName?: string | null; urgency: number };
  steps: Record<string, { output: { name: string } }>;
}

// --- Fields (module-scope consts) -----------------------------------------------
export const requestedSlot = p.string({ title: "Requested slot" });
export const contactName = p.string({ title: "Contact name" });
export const urgency = p.number({ title: "Urgency (1–5)", required: true });

// --- Effects --------------------------------------------------------------------
// An external lookup (mocked in scenarios) that returns the assigned baker, e.g.
// `{ name: "north-riverside-bakery" }`. `<{ name: string }>` types its output.
export const fetchBaker = effect<{ name: string }>("fetch-baker", "http:backstage:request", {
  name: "Fetch the assigned baker",
  input: { path: "/api/bakery/assignment" },
});

// Compose the notification. Every input is an `nj(...)` fallback expression; the
// two that read the baker's name make `notify` order AFTER `fetch-baker`.
export const notify = effect("notify", "debug:log", {
  name: "Compose the notification",
  input: {
    // NULL-AWARE ??: null/absent → the fallback; a present value (incl. "") stays.
    slot: nj((c: NotifierCtx) => c.parameters.requestedSlot ?? "next-available"),
    // Fallback-then-method: a named contact wins and is upper-cased; a missing one
    // falls back to the fetched baker name, then upper-cased.
    recipient: nj((c: NotifierCtx) => (c.parameters.contactName || c.steps["fetch-baker"].output.name).toUpperCase()),
    // Template literal mixing text + a number.
    banner: nj((c: NotifierCtx) => `Delivery slot — urgency ${c.parameters.urgency}`),
    // Comparison ternary.
    tier: nj((c: NotifierCtx) => (c.parameters.urgency >= 3 ? "URGENT" : "standard")),
    // Method-call passthrough: the region prefix of the baker's slug.
    region: nj((c: NotifierCtx) => c.steps["fetch-baker"].output.name.split("-")[0]),
  },
});

export const DeliverySlotNotifier = defineTemplate({
  id: "delivery-slot-notifier",
  title: "Delivery Slot Notifier",
  description: "Notify a baker of a delivery slot, filling gaps with sensible fallbacks.",
  type: "service",
  tags: ["bakery", "delivery", "notify"],
  owner: "team-bakery",
  pages: [page("Delivery", { requestedSlot, contactName, urgency })],
  // Both effects are declared roots; `notify` orders after `fetch-baker` by data ref.
  effects: [fetchBaker, notify],
});
