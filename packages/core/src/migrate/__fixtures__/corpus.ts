// The bakery migration CORPUS — a hand-written model that exercises EVERY node kind
// of the migration contract (ADR-0026), plus the mapping that drives the printer.
//
// It is TYPED as `MigrationModel` / `MigrationMapping`, so TypeScript accepts it
// (types-accept); `schema-parity.test.ts` also asserts the JSON Schema accepts it
// (schema-accepts). The printer's round-trip test compiles/executes the golden the
// printer emits from this. The theme is the fictional legacy "oven-booking system".

import type { MigrationMapping, MigrationModel } from "../model.ts";

export const corpus: MigrationModel = {
  modelVersion: "1",
  template: {
    id: "request-oven-maintenance",
    title: "Request oven maintenance",
    description: "Raise a maintenance work order for a bakery oven.",
    type: "service",
    tags: ["bakery", "oven", "maintenance"],
    owner: "team-bakery",
  },
  questions: [
    // Page 1 — Site. A choice with a value→label map, a plain string, a number.
    {
      name: "bakeryCode",
      type: "choice",
      title: "Bakery site",
      options: { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
      required: true,
      exampleValue: "BK1",
      page: "Site",
    },
    { name: "ovenId", type: "string", title: "Oven asset ID", required: true, exampleValue: "OV-4471", page: "Site" },
    { name: "ovenCount", type: "number", title: "How many ovens?", minimum: 1, exampleValue: 2, page: "Site" },
    // Page 2 — Fault. A choice + a conditional string (`is`), a severity choice + a
    // conditional string (`is`), and an `all`/`in` conditional boolean.
    {
      name: "faultType",
      type: "choice",
      title: "Fault type",
      options: { heating: "Heating", door: "Door", controls: "Controls", other: "Other" },
      required: true,
      exampleValue: "other",
      page: "Fault",
    },
    {
      name: "faultDetail",
      type: "string",
      title: "Describe the fault",
      uiWidget: "textarea",
      exampleValue: "Door seal warped, heat escaping",
      page: "Fault",
      visibleWhen: { field: "faultType", is: "other" },
    },
    {
      name: "severity",
      type: "choice",
      title: "Severity",
      options: { low: "Low", normal: "Normal", urgent: "Urgent" },
      required: true,
      exampleValue: "urgent",
      page: "Fault",
    },
    {
      name: "urgentReason",
      type: "string",
      title: "Why is this urgent?",
      exampleValue: "Production line stopped",
      page: "Fault",
      visibleWhen: { field: "severity", is: "urgent" },
    },
    {
      name: "escalate",
      type: "boolean",
      title: "Escalate to the facilities lead?",
      exampleValue: true,
      page: "Fault",
      visibleWhen: {
        all: [
          { field: "faultType", is: "other" },
          { field: "severity", in: ["normal", "urgent"] },
        ],
      },
    },
    // Page 3 — Parts. An array feeds the listMap logic node.
    {
      name: "partNumbers",
      type: "array",
      title: "Replacement part numbers",
      exampleValue: ["A1", "B2"],
      page: "Parts",
    },
  ],
  logic: [
    // template op — string interpolation over field refs.
    {
      name: "job-summary",
      op: "template",
      template: "Oven {oven} at {site}",
      bindings: { oven: { op: "fieldRef", field: "ovenId" }, site: { op: "fieldRef", field: "bakeryCode" } },
    },
    // conditional op — an if/else chain over literals.
    {
      name: "sla-hours",
      op: "conditional",
      cases: [
        { when: { field: "severity", is: "urgent" }, then: { op: "literal", value: 4 } },
        { when: { field: "severity", is: "normal" }, then: { op: "literal", value: 24 } },
      ],
      else: { op: "literal", value: 72 },
    },
    // listMap op — map an array field to a list.
    {
      name: "parts-list",
      op: "listMap",
      source: { op: "fieldRef", field: "partNumbers" },
      as: "part",
      body: {
        op: "concat",
        parts: [
          { op: "literal", value: "OV-" },
          { op: "fieldRef", field: "part" },
        ],
      },
    },
    // concat op + logicRef — reference another logic node and a field.
    {
      name: "escalation-note",
      op: "concat",
      parts: [
        { op: "literal", value: "Re: " },
        { op: "logicRef", ref: "job-summary" },
        { op: "literal", value: " (severity " },
        { op: "fieldRef", field: "severity" },
        { op: "literal", value: ")" },
      ],
    },
    // The escape hatch — a verbatim expression the IR cannot express.
    {
      name: "priority-code",
      kind: "expression",
      language: "jsonata",
      source: '$count(partNumbers) > 3 ? "bulk" : "standard"',
    },
  ],
  lookups: [
    // A MAPPED lookup (resolver convention supplied) — still flagged, by design.
    {
      name: "assignee",
      kind: "roster",
      source: "roster://maintenance-team?site={bakeryCode}",
      params: { site: { op: "fieldRef", field: "bakeryCode" } },
      at: "oven-maintenance.export.json#/fields/assignee",
    },
  ],
  effects: [
    // A MAPPED effect — becomes a typed pack-helper call.
    {
      name: "submit-request",
      kind: "workOrder",
      actionRef: "legacy:oven-booking:create-work-order",
      inputs: {
        title: { ref: "job-summary" },
        site: { ref: "bakeryCode" },
        oven: { ref: "ovenId" },
        sla: { logicRef: "sla-hours" },
        parts: { logicRef: "parts-list" },
        note: { logicRef: "escalation-note" },
        priority: { logicRef: "priority-code" },
        detail: { questionRef: "faultDetail" },
        assignee: { ref: "assignee" },
      },
    },
    // An UNMAPPED effect — a flagged direct effect(...), with a run condition.
    {
      name: "notify-facilities",
      kind: "notify",
      actionRef: "legacy:oven-booking:notify",
      inputs: { summary: { ref: "job-summary" }, reason: { questionRef: "urgentReason" } },
      when: { field: "severity", is: "urgent" },
      at: "oven-maintenance.export.json#/actions/notify",
    },
  ],
  outputs: {
    workOrderId: { effectRef: "submit-request", path: ["body", "id"] },
    sla: { logicRef: "sla-hours" },
  },
};

/** The org-supplied mapping: the mapped action + the mapped lookup. */
export const corpusMapping: MigrationMapping = {
  actions: {
    "legacy:oven-booking:create-work-order": { import: { name: "createWorkOrder", from: "./pack.ts" } },
  },
  lookups: {
    roster: { import: { name: "maintenanceRoster", from: "./pack.ts" } },
  },
};
