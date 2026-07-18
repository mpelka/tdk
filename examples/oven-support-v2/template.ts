// EXAMPLE 7 — "Oven Support Request (v2)": the AUTHORING-V2 surface, end to end.
//
// The AFTER half of the before/after pair with `examples/oven-support` (example 6):
// the SAME oven-support request, now authored the way ADR-0025 Decision 4 promises —
// a dataflow graph of module-scope values. Read the two side by side to see what the
// v2 migration changes (v1: `parameters`/`steps`/functional `output`; v2: `pages`/
// `effects`/handle `output`). The pair stays UNMIGRATED on purpose — it is the
// demonstration (ADR-0025 phase 4, #19).
//
//   - FIELDS are module-scope consts with their OWN visibility (`.showWhen(...)`),
//     built with `p.choice` (the enum/enumNames sugar).
//   - DERIVES (`derive(...)`) declare the runtime-computed values; a conditional
//     field types as `T | undefined`, so the lambda handles absence.
//   - ONE EFFECT (`raiseTicket(...)`, a pack helper wrapping `effect(...)`) is the
//     side-effectful submit step, returning a typed handle.
//   - PAGES are the ordered table of contents (the `page(title, props)` map form),
//     from which each page's `ui:order` is INFERRED (base fields, source order).
//   - `effects:` are the reachability roots; `output:` is a PLAIN map that reads
//     the effect's output BY HANDLE (`ticket.output.body.url`) — no `f` closure,
//     no hand-written `${{ steps[...] }}` string.
//
// The compiler collects the steps (three derives + the effect), plans their order
// (data-dependency first), synthesises the `dependencies`/`ui:order` schema, and
// wires every reference. The hand-written gold-standard.yaml is the behavioural
// oracle; the tests prove value-for-value agreement and per-derive expression
// equivalence, exactly as the phase-3a example does.

import { defineTemplate, derive, p, page } from "@tdk/core";
import { raiseTicket } from "./plugin.ts";

// --- Fields (module-scope consts, each with its own visibility) -----------------
// Page 1 — oven and site.
export const bakeryCode = p.choice(
  { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
  { title: "Bakery site", required: true },
);
export const ovenId = p.string({ title: "Oven asset ID", required: true });
export const ovenType = p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true });

// Page 2 — the problem. `otherDetail` and `urgentReason` are CONDITIONAL (each
// shown only for a specific controller value), via `.showWhen(...)`.
export const severity = p.choice(
  { low: "Low", normal: "Normal", urgent: "Urgent" },
  { title: "Severity", required: true },
);
export const problemArea = p.choice(["heating", "conveyor", "controls", "other"], {
  title: "Problem area",
  required: true,
});
export const otherDetail = p.string({ title: "Describe the problem" }).showWhen(problemArea.is("other"));
export const urgentReason = p.string({ title: "Why is this urgent?" }).showWhen(severity.is("urgent"));

// Page 3 — contact.
export const contactEmail = p.string({ title: "Who should we update?", format: "email", required: true });

// --- Derived values -------------------------------------------------------------
export const ticketTitle = derive(
  "ticket-title",
  { bakeryCode, ovenId, severity },
  (i) => `${i.severity === "urgent" ? "[URGENT] " : ""}Oven ${i.ovenId} at ${i.bakeryCode}`,
);

export const slaHours = derive("sla-hours", { severity }, (i) =>
  i.severity === "urgent" ? 4 : i.severity === "normal" ? 24 : 72,
);

// CONDITIONAL: `i.otherDetail` is `string | undefined`, so the lambda handles the
// absence the type surfaces (`|| "unspecified"`), exactly as ADR-0025 §2 shows.
export const problemSummary = derive("problem-summary", { problemArea, otherDetail }, (i) =>
  i.problemArea === "other" ? i.otherDetail || "unspecified" : i.problemArea,
);

// --- The effect (a pack helper returning a typed handle) ------------------------
// `ticket.output.body.url` / `.id` are checked references. `urgentReason.ref.orElse("")`
// supplies the default the compiler would otherwise make us defend by hand (§5).
export const ticket = raiseTicket("open-oven-ticket", {
  title: ticketTitle,
  slaHours,
  summary: problemSummary,
  site: bakeryCode,
  oven: ovenId,
  ovenType,
  urgentReason: urgentReason.ref.orElse(""),
  contact: contactEmail,
});

export const OvenSupportRequestV2 = defineTemplate({
  id: "oven-support-request-v2",
  title: "Request oven support (v2)",
  description: "Raise an oven-support ticket, assembling its fields from the submitted form.",
  type: "service",
  tags: ["bakery", "oven", "support"],
  owner: "team-bakery",
  // Pages ARE the ordered table of contents; ui:order is inferred per page.
  pages: [
    page("Oven and site", { bakeryCode, ovenId, ovenType }),
    page("The problem", { severity, problemArea, otherDetail, urgentReason }),
    page("Contact", { contactEmail }),
  ],
  // Effects are the reachability roots; the three derives are pulled in through
  // the effect's inputs, and planned in front of it.
  effects: [ticket],
  // Output reads the effect's output BY HANDLE — no hand-written step reference.
  output: {
    ticketUrl: ticket.output.body.url,
    ticketId: ticket.output.body.id,
  },
});
