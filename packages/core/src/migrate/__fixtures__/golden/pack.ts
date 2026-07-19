// The org-supplied pack the golden template imports — the PRIVATE side of the wall,
// hand-written (never generated). It publishes the mapped action helper
// (`createWorkOrder`) and the mapped lookup marker (`maintenanceRoster`) the printer
// wired the migration to. Modelled on `examples/oven-support-v2/plugin.ts`.
//
// This exists so the golden `template.ts` typechecks, compiles, and executes — the
// round-trip proof (ADR-0026 gates 1 and 2).

import {
  effect,
  type EffectHandle,
  type EffectInputValue,
  type InputValue,
  raw,
  registerActionSimulator,
} from "@tdk/core";

const CREATE_WORK_ORDER_ACTION = "bakery:create-work-order";

/** The output shape the create-work-order action returns. */
export interface WorkOrderOutput {
  body: { id: string; url: string };
}

/** The typed args the `createWorkOrder` effect helper accepts. */
export interface CreateWorkOrderArgs {
  title: EffectInputValue;
  site: EffectInputValue;
  oven: EffectInputValue;
  sla: EffectInputValue;
  parts: EffectInputValue;
  note: EffectInputValue;
  priority: EffectInputValue;
  detail: EffectInputValue;
  assignee: EffectInputValue;
}

/** The `execute()` simulator — computes a receipt from the rendered input. */
function simulateCreateWorkOrder(input: Record<string, unknown>): WorkOrderOutput {
  const id = `WO-${String(input.oven ?? "unknown")}`;
  return { body: { id, url: `https://catalog.example/work-orders/${id}` } };
}
registerActionSimulator(CREATE_WORK_ORDER_ACTION, simulateCreateWorkOrder);

/** The mapped action helper — returns a typed `EffectHandle<WorkOrderOutput>`. */
export function createWorkOrder(id: string, args: CreateWorkOrderArgs): EffectHandle<WorkOrderOutput> {
  return effect<WorkOrderOutput>(id, CREATE_WORK_ORDER_ACTION, {
    name: "Create the oven work order",
    input: {
      title: args.title,
      site: args.site,
      oven: args.oven,
      sla: args.sla,
      parts: args.parts,
      note: args.note,
      priority: args.priority,
      detail: args.detail,
      assignee: args.assignee,
    },
  });
}

/** The mapped lookup marker — an org resolver convention. Returns an input value. */
export function maintenanceRoster(_params: { site: EffectInputValue }): InputValue {
  // A stand-in for the org's real resolver marker; enough to typecheck + compile.
  return raw`maintenance-roster`;
}
