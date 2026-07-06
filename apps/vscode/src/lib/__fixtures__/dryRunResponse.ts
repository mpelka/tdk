// The captured, REDACTED, bakery-only Backstage dry-run response — a REAL 200 from a
// local Backstage (roadiehq:utils:jsonata registered), used to design + test the dry-run
// trace adapter against reality rather than a hand-rolled guess.
//
// Push-safety: the capture is the synthetic cake-order theme (Alice Baker / CROISSANT /
// SOURDOUGH / order ticket); its only non-theme tokens were the OpenTelemetry span/trace
// ids trailing each `info:` log line, scrubbed to fixed zeros (see the JSON). The ANSI
// colour codes (`[32m…`) and the resolved-input JSON blobs are preserved verbatim —
// the adapter's ANSI-stripping and resolved-input recovery are tested against them.
//
// `sourceSteps` + `parameters` mirror what the extension would have submitted (the
// compiled `spec.steps[]` `${{ … }}` SOURCE, and the form values) — the two halves the
// adapter pairs into provenance, exactly as the local trace path does.

import type { DryRunSuccessBody } from "../dryRunClient.ts";
import response from "./dryRunResponse.bakery.json" with { type: "json" };

/** The captured 200 body, typed as the client's success shape. */
export const dryRunResponse = response as unknown as DryRunSuccessBody;

/**
 * The compiled `spec.steps[]` for this run — the `${{ … }}` SOURCE the adapter pairs
 * against the resolved values Backstage reported. Matches the compiled payload-assembly
 * template the response came from (the `data` sub-object holds the templated inputs; the
 * `expression` is a jsonata literal the author wrote, not a template).
 */
export const dryRunSourceSteps = [
  {
    id: "build-ticket",
    input: {
      data: {
        customerName: "${{ parameters.customerName }}",
        items: "${{ parameters.items }}",
        priority: "${{ parameters.priority }}",
        discountCode: "${{ parameters.discountCode }}",
      },
      expression: "( … a pretty-printed jsonata literal … )",
    },
  },
  {
    id: "log-ticket",
    input: {
      message: '${{ ("Ticket: " ~ (steps["build-ticket"].output.result.summary)) }}',
    },
  },
];

/** The form values the run submitted — each step's `${{ }}` context. */
export const dryRunParameters = {
  customerName: "Alice Baker",
  priority: "high",
  discountCode: "20OFF",
  items: [
    { sku: "CROISSANT", qty: 12, options: ["butter", "extra-flaky"] },
    { sku: "SOURDOUGH", qty: 2, options: [] },
  ],
};
