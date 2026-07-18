// EXAMPLE — "Oven Provisioner (v2)": the plugin-composition stress test, authored the
// AUTHORING-V2 way (ADR-0025), proving the three extension hooks COMPOSE with the v2
// effect surface — the "packs move to v2" story the flagship's plugin.ts foreshadows.
//
// It still uses all THREE hooks via the same inline plugin (`./plugin.ts`, unchanged):
//   - HOOK B (field): `cakePicker` — a `defineField` custom field, now a module-scope
//     const referenced in the page and by `.ref` in a step input and the output.
//   - HOOK B (action) + HOOK C (simulator): `provisionOven` — a `defineAction` step
//     helper. It returns a plain `Step`, so `rawEffect(...)` wraps it as an effect
//     (the v2 escape hatch for a v1-style action helper), PRESERVING the resolver
//     marker in its `if:`. Its registered `simulate` still drives `execute()`.
//   - HOOK A (resolver): `headBakerOf("pastry")` — resolved at compile time, used BOTH
//     in the provision step's `if:` AND as the `record` effect's `headBaker` input.
//
// v2 changes: fields are module-scope consts across a pages-as-TOC form; the two steps
// are an `effects:` list; and `record` reads the provisioned oven id BY HANDLE
// (`provisioned.output.ovenId`) instead of a hand-written `${{ steps.provision… }}`.
// Because a resolver marker is used, it compiles via the ASYNC path (compileResolved /
// execute). The gold hand-writes the RESOLVED artifact; the payload-equivalence test
// proves the v2 rewrite preserves the v1 payloads.

import { defineTemplate, effect, p, page, rawEffect } from "@tdk/core";
import { cakePicker, headBakerOf, provisionOven } from "./plugin.ts";

// --- Fields (module-scope consts) -----------------------------------------------
export const station = p.choice(["pastry", "bread"], { title: "Station", required: true });
export const capacity = p.number({ title: "Capacity (trays)", required: true });
// HOOK B (field): the CakePickerWithDefault picker, as a module-scope field.
export const ovenModel = cakePicker({
  catalog: "bakery/oven-models",
  default: "deck-3000",
  title: "Oven model",
  required: true,
});

// --- Effects --------------------------------------------------------------------
// HOOK B (action) via `rawEffect`: `provisionOven(...)` (a `defineAction` helper)
// yields a `bakery:provision-oven` STEP whose `if:` is the `headBakerOf("pastry")`
// resolver marker. `rawEffect` wraps that step as an effect (keeping id/action/input/
// if verbatim) and types its `.output`, so `provisioned.output.ovenId` is a checked
// reference. `model` consumes the CakePickerWithDefault field, so the custom field's
// value lands in a step input — the demo is complete end to end.
export const provisioned = rawEffect<{ ovenId: string; endpoint: string; ready: boolean }>(
  provisionOven({
    id: "provision",
    station: station.ref,
    capacity: capacity.ref,
    model: ovenModel.ref,
    if: headBakerOf("pastry"),
  }),
);

// The record log — reads the provisioned oven id BY HANDLE and the resolved head
// baker (HOOK A: the resolver marker as an effect input; the resolved id lands in the
// artifact, the marker never does).
export const record = effect("record", "debug:log", {
  name: "Record who owns the oven",
  input: {
    headBaker: headBakerOf("pastry"),
    ovenId: provisioned.output.ovenId,
  },
});

export const OvenProvisioner = defineTemplate({
  id: "oven-provisioner",
  title: "Oven Provisioner",
  description: "Provision a bakery oven for a station.",
  type: "service",
  tags: ["bakery", "oven", "infra"],
  owner: "team-bakery",
  pages: [page("Provision", { station, capacity, ovenModel })],
  // `record` reads `provisioned` by handle, so the planner orders provision first.
  effects: [provisioned, record],
  output: { station: station.ref, ovenModel: ovenModel.ref },
});
