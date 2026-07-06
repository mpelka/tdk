// Tests for the Oven Provisioner (all three extension hooks composed).
//
// The template uses a resolver marker, so it compiles via the ASYNC path
// (compileResolved / execute). Each test resets the registries and RE-INSTALLS the
// inline plugin (the same stable refs) for isolation, exactly like core's
// extend.test.ts. The invariants:
//   (a) the resolved head-baker id lands in the artifact; the marker never does,
//   (b) execute()'s provision output comes from the SIMULATOR (no fixture mock),
//   (c) one behaviour only — mock-vs-simulator precedence is NOT tested here (#26).

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  _resetActionSimulators,
  _resetEnvRegistry,
  _resetResolvers,
  assertExecuteAgainstGold,
  assertValid,
  compileResolved,
  execute,
  getActionSimulator,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { installOvenPlugin } from "./plugin.ts";
import { OvenProvisioner } from "./template.ts";

const nonprod = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");

// Reset every registry, then re-install the inline plugin (stable refs) so one
// test never leaks into the next and the resolver + simulator are always present.
beforeEach(() => {
  _resetResolvers();
  _resetActionSimulators();
  _resetEnvRegistry();
  installOvenPlugin();
});

describe("oven-provisioner — structure + the composed field", () => {
  test("two steps: the provision action then the record log", async () => {
    const { object } = await compileResolved(OvenProvisioner, nonprod);
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "provision", action: "bakery:provision-oven" },
      { id: "record", action: "debug:log" },
    ]);
  });

  test("HOOK B (field): cakePicker compiled to ui:field + ui:options", async () => {
    const { object } = await compileResolved(OvenProvisioner, nonprod);
    const params = object.spec.parameters as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const model = params.properties.ovenModel!;
    expect(model["ui:field"]).toBe("CakePickerWithDefault");
    expect(model["ui:options"]).toEqual({ path: "bakery/oven-models", default: "deck-3000" });
    expect(params.required).toContain("ovenModel");
  });
});

describe("oven-provisioner — the resolver (invariant a)", () => {
  test("the resolved head-baker id lands in the artifact; the marker never does", async () => {
    const { object, yaml } = await compileResolved(OvenProvisioner, nonprod);
    // The resolved id appears in BOTH the step `if:` and the record input.
    expect(object.spec.steps[0]!.if).toBe("baker-pastry-01");
    expect((object.spec.steps[1]!.input as { headBaker: string }).headBaker).toBe("baker-pastry-01");
    // The marker's internals never serialize into the YAML.
    expect(yaml).not.toContain("__tdkResolvable");
    expect(yaml).not.toContain("headBakerOf");
    expect(yaml).toContain("baker-pastry-01");
  });
});

describe("oven-provisioner — the action simulator (invariant b)", () => {
  test("the provision step's output is COMPUTED by the simulator (no mock supplied)", async () => {
    // Sanity: the simulator is registered (Hook C), so execute() will run it.
    expect(getActionSimulator("bakery:provision-oven")).toBeDefined();

    const run = await execute(OvenProvisioner, {
      parameters: { station: "pastry", capacity: 12, ovenModel: "deck-3000" },
    });
    // No fixture mock for `provision` — this output came from the simulator,
    // computed from the RENDERED input (station "pastry", capacity 12).
    expect(run.steps.provision!.output).toEqual({
      ovenId: "oven-pastry-12",
      endpoint: "https://ovens.example/pastry/12",
      ready: true,
    });
    // The downstream `record` step reads the simulated ovenId.
    expect((run.steps.record!.input as { ovenId: string }).ovenId).toBe("oven-pastry-12");
  });
});

describe("oven-provisioner — schema validity (both sides)", () => {
  test("the compiled (resolved) entity is schema-valid", async () => {
    const { object } = await compileResolved(OvenProvisioner, nonprod);
    await assertValid(object);
  });
  test("the hand-written gold is schema-valid", async () => {
    const { valid, errors } = await validate(parse(gold));
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("oven-provisioner — whole-run agreement vs the gold", () => {
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      // Both sides run the SAME registered simulator for `provision`, so the
      // computed outputs agree without any mock.
      await assertExecuteAgainstGold(OvenProvisioner, gold, scenario.fixture);
    });
  }
});
