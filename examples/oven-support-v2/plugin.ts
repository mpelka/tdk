// The bakery service-catalog pack — the EFFECT-helper pattern packs will use.
//
// A pack publishes typed EFFECT helpers the same way it publishes typed field
// helpers (`defineField`) and step helpers (`defineAction`). An effect helper is
// a `defineAction`-STYLE factory: it wraps core's `effect(id, action, opts)`,
// pins the action id and the OUTPUT SHAPE (`effect<TicketOutput>`), and — exactly
// as `defineAction`'s `simulate` does — registers an `execute()` simulator for the
// action at import time. Consumers then write `raiseTicket("open-oven-ticket",
// {...})` and get back a typed `EffectHandle<TicketOutput>` whose
// `.output.body.url` is a checked reference.
//
// This is the phase-4 migration pattern in miniature: when the packs move to v2,
// each side-effect action grows a helper like this one. Core ships only `effect`
// (+ `rawEffect`) and the simulator registry; the pack owns the shape.

import { type EffectHandle, type EffectInputValue, effect, registerActionSimulator } from "@tdk/core";

/** The action id the bakery service catalog exposes for raising a ticket. */
const RAISE_TICKET_ACTION = "bakery:raise-ticket";

/** The output shape `bakery:raise-ticket` returns — the effect handle's type `O`. */
export interface TicketOutput {
  body: {
    /** The created ticket's URL. */
    url: string;
    /** The created ticket's id. */
    id: string;
  };
}

/**
 * The typed args the `raiseTicket` effect helper accepts. `EffectInputValue`
 * admits any `InputValue` (a derive handle, an `.orElse(...)` marker, a literal)
 * AND a bare param CONST — so the author passes `site: bakeryCode` directly and
 * the effect normalizes it to `.ref` (ADR-0025 Decision 3).
 */
export interface RaiseTicketArgs {
  title: EffectInputValue;
  slaHours: EffectInputValue;
  summary: EffectInputValue;
  site: EffectInputValue;
  oven: EffectInputValue;
  ovenType: EffectInputValue;
  urgentReason: EffectInputValue;
  contact: EffectInputValue;
}

/**
 * `execute()` simulator for `bakery:raise-ticket` — computes the ticket receipt
 * from the RENDERED input, mirroring how the real action would behave. Registered
 * at import (the `defineAction`-`simulate` coupling), so a scenario WITHOUT a
 * fixture mock still runs the effect. A scenario WITH a `fixture.steps[id].output`
 * mock overrides this (mock-wins — the effect is a non-jsonata action).
 */
function simulateRaiseTicket(input: Record<string, unknown>): TicketOutput {
  const id = `TCK-${String(input.oven ?? "unknown")}`;
  return { body: { id, url: `https://catalog.example/tickets/${id}` } };
}

// Register at import, exactly as `defineAction({ simulate })` would.
registerActionSimulator(RAISE_TICKET_ACTION, simulateRaiseTicket);

/**
 * Re-register the simulator after a test clears the process-global registry for
 * isolation (same-reference re-registration is tolerated). Mirrors
 * `plugin-composed`'s `installOvenPlugin`.
 */
export function installBakeryCatalog(): void {
  registerActionSimulator(RAISE_TICKET_ACTION, simulateRaiseTicket);
}

/**
 * Raise an oven-support ticket in the service catalog — the pack's EFFECT helper.
 * Returns a typed `EffectHandle<TicketOutput>`: `ticket.output.body.url` /
 * `.id` are checked references, and the handle drops straight into a v2
 * template's `effects: [...]` list.
 */
export function raiseTicket(id: string, args: RaiseTicketArgs): EffectHandle<TicketOutput> {
  return effect<TicketOutput>(id, RAISE_TICKET_ACTION, {
    name: "Raise the oven-support ticket",
    input: {
      title: args.title,
      slaHours: args.slaHours,
      summary: args.summary,
      site: args.site,
      oven: args.oven,
      ovenType: args.ovenType,
      urgentReason: args.urgentReason,
      contact: args.contact,
    },
  });
}
