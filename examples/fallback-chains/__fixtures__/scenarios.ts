// Scenario fixtures for the Delivery Slot Notifier.
//
// `fetch-baker` is an external http step, so its output is MOCKED. The scenarios
// walk the fallback matrix: a present slot + named contact (nothing falls back);
// a null slot + missing contact (both fall back); an absent slot; and an
// empty-string slot (which `??` passes THROUGH — distinct from null/absent).

import type { ExecuteFixture } from "@tdk/core";

type NotifierParams = {
  requestedSlot?: string | null;
  contactName?: string | null;
  urgency: number;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<NotifierParams>;
}

export const scenarios: Scenario[] = [
  {
    // Nothing falls back: a present slot and a NAMED contact render unchanged
    // (invariant b — the named contact is NOT overwritten by the baker).
    name: "present slot + named contact — no fallback",
    branches: ["present", "named"],
    fixture: {
      parameters: { requestedSlot: "9am-slot", contactName: "Baker Sam", urgency: 4 },
      steps: { "fetch-baker": { output: { name: "north-riverside-bakery" } } },
    },
  },
  {
    // Null slot → the `??` fallback fires; missing contact → falls back to the
    // fetched baker name, upper-cased.
    name: "null slot + missing contact — both fall back",
    branches: ["null", "missing"],
    fixture: {
      parameters: { requestedSlot: null, urgency: 2 },
      steps: { "fetch-baker": { output: { name: "west-park-bakery" } } },
    },
  },
  {
    // Absent slot → same fallback as null (the `??` is null-AND-missing aware).
    name: "absent slot — fallback (same as null)",
    branches: ["absent"],
    fixture: {
      parameters: { urgency: 3 },
      steps: { "fetch-baker": { output: { name: "south-end-bakery" } } },
    },
  },
  {
    // Empty-string slot → `??` does NOT fire; "" passes through (the THIRD, distinct
    // outcome from null/absent). Empty contact → falls back to the baker name.
    name: "empty-string slot — passes through (distinct from null)",
    branches: ["empty"],
    fixture: {
      parameters: { requestedSlot: "", contactName: "", urgency: 1 },
      steps: { "fetch-baker": { output: { name: "east-side-bakery" } } },
    },
  },
];
