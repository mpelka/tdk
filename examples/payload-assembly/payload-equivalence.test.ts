// PAYLOAD-EQUIVALENCE — the phase-4 migration proof for payload-assembly.
//
// `__baseline__/payloads.json` was captured from the V1 template (the manual
// `build-ticket` jsonata step + `log-ticket` debug:log) BEFORE this dir was rewritten
// to authoring-v2. This test runs the SAME scenarios through the v2 template and
// asserts the payload digest (template output + each effect's rendered input/output,
// keyed by action; jsonata/derive steps dropped as topology) is byte-for-byte the
// baseline. It is the permanent record that the derive/effect rewrite preserved
// behaviour — see examples/payload-oracle.ts for the digest's contract.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _resetDeriveRegistry, compileResolved, execute } from "@tdk/core";
import { type PayloadDigest, payloadDigest } from "../payload-oracle.ts";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { OrderTicketBuilder } from "./template.ts";

const target = { env: "test", outDir: "" } as const;
const baseline = JSON.parse(readFileSync(new URL("./__baseline__/payloads.json", import.meta.url), "utf8")) as Record<
  string,
  PayloadDigest
>;

describe("payload-assembly — v2 reproduces the v1 payloads", () => {
  _resetDeriveRegistry();

  for (const scenario of scenarios) {
    test(`payload-equivalent — ${scenario.name}`, async () => {
      const { object } = await compileResolved(OrderTicketBuilder, target);
      const steps = (object.spec.steps ?? []) as Array<{ id?: string; action: string }>;
      const result = await execute(OrderTicketBuilder, scenario.fixture);
      expect(payloadDigest(steps, result)).toEqual(baseline[scenario.name]!);
    });
  }
});
