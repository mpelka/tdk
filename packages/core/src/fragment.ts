// Composition fragments — reusable, shareable pieces of a parameter form.
//
// A *fragment* is a self-contained chunk of a template authored ONCE and dropped
// into many templates. The v1 need is the simplest and most common one: contribute
// a reusable PAGE. A fragment is therefore just a `ColocatedPage`, so it flows
// through `compile`/`execute` unchanged and a template composes it by spreading it
// into `parameters`:
//
//   parameters: [...myPages, myStandardPage()]
//
// `fragment(title, props, opts?)` is the typed builder (a thin, intent-revealing
// wrapper over `page(...)`): the name signals the page is a shared standard rather
// than a one-off. CONCRETE org-specific fragments — e.g. a "Business Justification"
// page a team's lint rule mandates — are built ON TOP of `fragment(...)` and live in
// the CONSUMER's own shared template code, NOT here. Core stays org-agnostic and
// ships only the mechanism.

import { type ColocatedPage, type PageOptions, page } from "./pages.ts";
import type { ParamMap } from "./params.ts";

/**
 * Build a reusable form-page fragment. Identical at runtime to the colocated
 * `page(title, props, opts?)` form (and preserves the precise `Props` type so a
 * composing `defineTemplate` still infers a typed `f` field-ref map), but the
 * name documents intent: this page is authored once and SHARED across templates.
 */
export function fragment<Props extends ParamMap>(
  title: string,
  props: Props,
  opts?: PageOptions,
): ColocatedPage<Props> {
  return page(title, props, opts);
}
