// PAYLOAD-EQUIVALENCE — the phase-4 migration proof for fallback-chains.
//
// `__baseline__/payloads.json` was captured from the V1 template (the manual
// `fetch-baker` + `notify` steps) BEFORE this dir was rewritten to authoring-v2. This
// test runs the SAME scenarios through the v2 template and asserts the payload digest
// (each effect's rendered input/output keyed by action; there is no template output)
// is byte-for-byte the baseline — the permanent record that moving the steps into an
// `effects:` list preserved the nj fallback matrix. See examples/payload-oracle.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compileResolved, execute, type TemplateInput } from "@tdk/core";
import { type PayloadDigest, payloadDigest } from "../payload-oracle.ts";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { DeliverySlotNotifier } from "./template.ts";

const target = { env: "test", outDir: "" } as const;
const baseline = JSON.parse(readFileSync(new URL("./__baseline__/payloads.json", import.meta.url), "utf8")) as Record<
  string,
  PayloadDigest
>;

describe("fallback-chains — v2 reproduces the v1 payloads", () => {
  for (const scenario of scenarios) {
    test(`payload-equivalent — ${scenario.name}`, async () => {
      const { object } = await compileResolved(DeliverySlotNotifier, target);
      const steps = (object.spec.steps ?? []) as Array<{ id?: string; action: string }>;
      // Some fixtures set `requestedSlot: null` (the `??` null path) — a runtime value
      // Backstage can send that the field's `string` type doesn't model; cast to the
      // loose template input so execute() takes the fixture verbatim.
      const result = await execute(DeliverySlotNotifier as TemplateInput, scenario.fixture);
      expect(payloadDigest(steps, result)).toEqual(baseline[scenario.name]!);
    });
  }
});
