// Scenario fixtures for the Custom Cake Order Wizard.
//
// `execute()` renders the form + the single `debug:log` step; the conditional
// FIELDS live in the parameter schema (not the run), so these scenarios pin the
// run-time behaviour: whatever `orderType` (and the other fields) are submitted,
// the step message and output reflect them. The `standard` scenario is the
// invariant-(b) witness — no wedding fields are supplied and none surface.

import type { ExecuteFixture } from "@tdk/core";

// A `type` (not `interface`) with an index signature so it satisfies the
// `P extends Record<string, unknown>` bound on `assertExecuteAgainstGold`.
type WizardParams = {
  orderType: "standard" | "custom" | "wedding";
  tiers?: number;
  topper?: boolean;
  topperText?: string;
  packaging?: "box" | "ribbon";
  ribbonColor?: string;
  rush?: boolean;
  rushJustification?: string;
  bakerNotes?: string;
  contactEmail?: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<WizardParams>;
}

export const scenarios: Scenario[] = [
  {
    // Invariant (b): a standard order renders NO wedding fields — the run only
    // ever sees what was submitted, and nothing wedding-specific was.
    name: "standard order — no wedding fields",
    branches: ["standard"],
    fixture: {
      parameters: { orderType: "standard", packaging: "box", contactEmail: "sam@bakery.example" },
      steps: { "log-order": { output: {} } },
    },
  },
  {
    // A full wedding order: the two-level chain's fields are all present.
    name: "wedding order — tiers + topper + topper text",
    branches: ["wedding", "topper"],
    fixture: {
      parameters: {
        orderType: "wedding",
        tiers: 3,
        topper: true,
        topperText: "Mr & Mrs Baker",
        packaging: "ribbon",
        ribbonColor: "gold",
        rush: false,
        contactEmail: "wedding@bakery.example",
      },
      steps: { "log-order": { output: {} } },
    },
  },
  {
    // A rush custom order exercising the rawDependencies controller's justification.
    name: "custom rush order",
    branches: ["custom", "rush"],
    fixture: {
      parameters: {
        orderType: "custom",
        packaging: "box",
        rush: true,
        rushJustification: "Birthday is tomorrow",
        bakerNotes: "Please use dark chocolate",
        contactEmail: "rush@bakery.example",
      },
      steps: { "log-order": { output: {} } },
    },
  },
];
