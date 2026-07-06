// A shared "Baker Notes" page FRAGMENT — authored once, dropped into any template
// that needs a free-text note plus a contact email. This is the consumer-side
// pattern SKILL.md describes: concrete org fragments live in YOUR shared code and
// are built on top of core's `fragment(...)` mechanism (core stays org-agnostic).
//
// `fragment(title, props)` is identical at runtime to `page(title, props)`, but the
// name documents that this page is a reusable standard rather than a one-off.

import { fragment, p } from "@tdk/core";

/**
 * The reusable Baker Notes page: a textarea note (`bakerNotes`) and a required
 * `contactEmail` constrained to the JSON-Schema `email` format. Composed verbatim
 * as the LAST page of a form.
 *
 * `contactEmail` carries a STRING `errorMessage` (issue #59) — one human message
 * covering BOTH failures it can produce (a missing value and a malformed address),
 * emitted as the ajv-errors `errorMessage` keyword so the preview and Backstage's
 * own RJSF render it in place of "must have required property …" / "must match
 * format email". The string shorthand is what covers the required case too: it
 * lands on the field (its format failure) AND lifts to the page's
 * `errorMessage.required` (its missing-value failure).
 */
export const bakerNotesPage = () =>
  fragment("Baker Notes", {
    bakerNotes: p.string({ title: "Notes for the baker", uiWidget: "textarea" }),
    contactEmail: p.string({
      title: "Contact email",
      format: "email",
      required: true,
      errorMessage: "Enter a valid contact email so the baker can reach you.",
    }),
  });
