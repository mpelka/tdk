// Scenario fixtures for the Oven Support Request (v2).
//
// The three derived values are `roadiehq:utils:jsonata` steps, so `execute()` runs
// them FOR REAL. The single EFFECT (`open-oven-ticket`, `bakery:raise-ticket`) is a
// NON-jsonata action, so its output comes from mock-wins precedence:
//   - scenario 1 supplies an explicit `fixture.steps[...]` mock — it WINS over the
//     pack's registered simulator (the effect-mocking contrast the derive caveat
//     lacks: a jsonata derive is always computed, an effect defers to the mock),
//   - scenarios 2 & 3 supply NO mock — the pack's registered `simulateRaiseTicket`
//     computes the receipt from the rendered input.
// Either way the template `output` reads the effect's `.body.url` / `.body.id`.

import type { ExecuteFixture } from "@tdk/core";

type OvenParams = {
  bakeryCode: "BK1" | "BK2" | "BK3";
  ovenId: string;
  ovenType: "deck" | "convection" | "rack";
  severity: "low" | "normal" | "urgent";
  problemArea: "heating" | "conveyor" | "controls" | "other";
  otherDetail?: string;
  urgentReason?: string;
  contactEmail: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<OvenParams>;
}

export const scenarios: Scenario[] = [
  {
    name: "urgent — other problem, ticket MOCKED (mock wins over the simulator)",
    branches: ["urgent", "other"],
    fixture: {
      parameters: {
        bakeryCode: "BK1",
        ovenId: "OV-4471",
        ovenType: "deck",
        severity: "urgent",
        problemArea: "other",
        otherDetail: "Door seal warped, heat escaping",
        urgentReason: "Production line stopped",
        contactEmail: "baker@riverside.example",
      },
      // The explicit mock WINS over the pack's registered simulator — the effect is
      // a non-jsonata action, so this scenario pins its output shape exactly.
      steps: {
        "open-oven-ticket": {
          output: { body: { id: "TCK-8801", url: "https://catalog.example/tickets/8801" } },
        },
      },
    },
  },
  {
    name: "normal — heating problem, ticket SIMULATED (no mock)",
    branches: ["normal", "heating"],
    fixture: {
      parameters: {
        bakeryCode: "BK2",
        ovenId: "OV-1200",
        ovenType: "convection",
        severity: "normal",
        problemArea: "heating",
        contactEmail: "ops@oldtown.example",
      },
      // No mock — the pack's simulateRaiseTicket computes the receipt from input.
    },
  },
  {
    name: "low — conveyor problem, ticket SIMULATED (no mock)",
    branches: ["low", "conveyor"],
    fixture: {
      parameters: {
        bakeryCode: "BK3",
        ovenId: "OV-0007",
        ovenType: "rack",
        severity: "low",
        problemArea: "conveyor",
        contactEmail: "team@harbourfront.example",
      },
    },
  },
];
