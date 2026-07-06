// EXAMPLE 5 — "Oven Provisioner": the plugin-composition stress test.
//
// It uses all THREE extension hooks via a small inline plugin (`./plugin.ts`,
// which imports only the public barrel — it does NOT import core's own
// plugin-bakery fixture):
//   - a `cakePicker` FIELD (defineField over p.customField),
//   - a `provisionOven` ACTION with a `simulate` (defineAction + Hook C) — its
//     simulator computes the step output from the RENDERED input, so execute()
//     needs no fixture mock for it,
//   - a `headBakerOf(station)` RESOLVER (defineResolver) whose marker is resolved
//     at compile time — used BOTH as a step input (so the resolved id lands in the
//     artifact) AND in a step `if:` (a resolver marker in a run condition).
//
// Because it uses a resolver marker, it compiles via the ASYNC path
// (compileResolved / execute) — the sync compile() throws on an unresolved marker.
//
// The gold-standard.yaml hand-writes the RESOLVED artifact (the concrete head-baker
// id, never the marker); the tests assert the compiled artifact agrees and that the
// simulator drives execute()'s output.

import { defineTemplate, nj, p, step } from "@tdk/core";
import { cakePicker, headBakerOf, provisionOven } from "./plugin.ts";

export const OvenProvisioner = defineTemplate({
  id: "oven-provisioner",
  title: "Oven Provisioner",
  description: "Provision a bakery oven for a station.",
  type: "service",
  tags: ["bakery", "oven", "infra"],
  owner: "team-bakery",
  parameters: {
    station: p.enum(["pastry", "bread"], { title: "Station", required: true }),
    capacity: p.number({ title: "Capacity (trays)", required: true }),
    // HOOK B (field): the CakePickerWithDefault picker.
    ovenModel: cakePicker({ catalog: "bakery/oven-models", default: "deck-3000", title: "Oven model", required: true }),
  },
  steps: (f) => [
    // HOOK B (action) + HOOK C (simulator): the provision step. Its `if:` is a
    // RESOLVER marker — `headBakerOf("pastry")` resolves to a non-empty id, so the
    // step runs only when the pastry station has a head baker assigned. `model`
    // CONSUMES the CakePickerWithDefault field (`f.ovenModel`), so the custom field's
    // value lands in a step input — the demo is complete end to end.
    provisionOven({
      id: "provision",
      station: f.station,
      capacity: f.capacity,
      model: f.ovenModel,
      if: headBakerOf("pastry"),
    }),
    step("record", "debug:log", {
      name: "Record who owns the oven",
      input: {
        // HOOK A (resolver): the resolved head-baker id lands in the artifact here
        // (the marker itself never does).
        headBaker: headBakerOf("pastry"),
        ovenId: nj((c) => c.steps.provision.output.ovenId),
      },
    }),
  ],
  output: (f) => ({ station: f.station, ovenModel: f.ovenModel }),
});
