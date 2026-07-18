// Scenario fixtures for the Oven Support Request.
//
// The five derived values are `roadiehq:utils:jsonata` steps, so `execute()` runs
// them FOR REAL — these scenarios pin the assembled ticket across the interesting
// inputs. The two MANUAL steps (`oven-lookup`, `register`) are mocked: their output
// is supplied per scenario, and `oven-context` derives from the lookup mock.
//   - an urgent "other" ticket (otherDetail PRESENT → used verbatim, [URGENT] prefix,
//     SLA 4h),
//   - a normal heating ticket (otherDetail ABSENT → the conditional field is hidden,
//     so the summary is the area itself; SLA 24h),
//   - a low conveyor ticket (otherDetail ABSENT; SLA 72h).

import type { ExecuteFixture } from "@tdk/core";

type OvenParams = {
  bakeryCode: "BK1" | "BK2" | "BK3";
  ovenId: string;
  severity: "low" | "normal" | "urgent";
  problemArea: "heating" | "conveyor" | "controls" | "other";
  otherDetail?: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<OvenParams>;
}

export const scenarios: Scenario[] = [
  {
    name: "urgent — other problem with detail, rush SLA",
    branches: ["urgent", "other"],
    fixture: {
      parameters: {
        bakeryCode: "BK1",
        ovenId: "OV-4471",
        severity: "urgent",
        problemArea: "other",
        otherDetail: "Door seal warped, heat escaping",
      },
      steps: {
        "oven-lookup": { output: { model: "Rondo Deck 3", installedYear: 2019 } },
        register: { output: { ticketId: "TCK-8801", url: "https://catalog.example/tickets/8801" } },
      },
    },
  },
  {
    name: "normal — heating problem, no detail field",
    branches: ["normal", "heating"],
    fixture: {
      parameters: {
        bakeryCode: "BK2",
        ovenId: "OV-1200",
        severity: "normal",
        problemArea: "heating",
      },
      steps: {
        "oven-lookup": { output: { model: "Convotherm Mini", installedYear: 2022 } },
        register: { output: { ticketId: "TCK-8802", url: "https://catalog.example/tickets/8802" } },
      },
    },
  },
  {
    name: "low — conveyor problem, no detail field",
    branches: ["low", "conveyor"],
    fixture: {
      parameters: {
        bakeryCode: "BK3",
        ovenId: "OV-0007",
        severity: "low",
        problemArea: "conveyor",
      },
      steps: {
        "oven-lookup": { output: { model: "Rack Master 60", installedYear: 2015 } },
        register: { output: { ticketId: "TCK-8803", url: "https://catalog.example/tickets/8803" } },
      },
    },
  },
];
