// Scenario fixtures for the cake-order template's `execute(...)` simulation, used
// by the CLI tests for `tdk execute`. The single `debug:log` step is non-pure,
// so its output is mocked; the run just needs to succeed and echo the resolved
// input back so the CLI test can assert on the JSON shape.

import type { ExecuteFixture } from "@tdk/core";

interface Scenario {
  name: string;
  branches?: string[];
  fixture: ExecuteFixture<{ customer: string }>;
}

export const scenarios: Scenario[] = [
  {
    name: "orders for alice",
    branches: ["default"],
    fixture: {
      parameters: { customer: "Alice" },
      steps: { order: { output: {} } },
    },
  },
];
