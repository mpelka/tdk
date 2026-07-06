// Scenario fixtures for the Oven Provisioner.
//
// The `provision` step has a registered SIMULATOR (Hook C), so execute() computes
// its output from the rendered input — these fixtures supply NO mock for it
// (invariant b: the simulator is the source of truth). The `record` step is a
// debug:log; its output isn't consumed downstream, so no mock is needed either.
//
// The provision step's `if:` is the resolved head-baker id (a non-empty string),
// so the step always runs in these scenarios.

import type { ExecuteFixture } from "@tdk/core";

type OvenParams = {
  station: "pastry" | "bread";
  capacity: number;
  ovenModel?: string;
} & Record<string, unknown>;

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<OvenParams>;
}

export const scenarios: Scenario[] = [
  {
    name: "provision a pastry oven",
    branches: ["pastry"],
    fixture: {
      parameters: { station: "pastry", capacity: 12, ovenModel: "deck-3000" },
    },
  },
  {
    name: "provision a bread oven",
    branches: ["bread"],
    fixture: {
      parameters: { station: "bread", capacity: 24, ovenModel: "rack-500" },
    },
  },
  {
    name: "provision a small pastry oven",
    branches: ["pastry", "small"],
    fixture: {
      parameters: { station: "pastry", capacity: 4, ovenModel: "deck-3000" },
    },
  },
];
