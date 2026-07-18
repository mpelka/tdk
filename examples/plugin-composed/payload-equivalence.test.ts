// PAYLOAD-EQUIVALENCE — the phase-4 migration proof for plugin-composed.
//
// `__baseline__/payloads.json` was captured from the V1 template (the manual
// `provision` + `record` steps) BEFORE this dir was rewritten to authoring-v2. This
// test runs the SAME scenarios through the v2 template and asserts the payload digest
// (template output + each effect's rendered input/output keyed by action) is
// byte-for-byte the baseline — the permanent record that wrapping the `defineAction`
// step in `rawEffect` and reading the oven id by handle preserved behaviour, resolver
// and simulator included. See examples/payload-oracle.ts.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _resetActionSimulators, _resetEnvRegistry, _resetResolvers, compileResolved, execute } from "@tdk/core";
import { type PayloadDigest, payloadDigest } from "../payload-oracle.ts";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { installOvenPlugin } from "./plugin.ts";
import { OvenProvisioner } from "./template.ts";

const target = { env: "test", outDir: "" } as const;
const baseline = JSON.parse(readFileSync(new URL("./__baseline__/payloads.json", import.meta.url), "utf8")) as Record<
  string,
  PayloadDigest
>;

// The registries are process-wide; re-install the inline plugin (stable refs) so a
// reset in another test file can't strip the resolver/simulator this template needs.
beforeEach(() => {
  _resetResolvers();
  _resetActionSimulators();
  _resetEnvRegistry();
  installOvenPlugin();
});

describe("plugin-composed — v2 reproduces the v1 payloads", () => {
  for (const scenario of scenarios) {
    test(`payload-equivalent — ${scenario.name}`, async () => {
      const { object } = await compileResolved(OvenProvisioner, target);
      const steps = (object.spec.steps ?? []) as Array<{ id?: string; action: string }>;
      const result = await execute(OvenProvisioner, scenario.fixture);
      expect(payloadDigest(steps, result)).toEqual(baseline[scenario.name]!);
    });
  }
});
