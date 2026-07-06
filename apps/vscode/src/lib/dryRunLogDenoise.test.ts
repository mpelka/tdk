// Unit tests for the dry-run log DE-NOISER (item #3) — collapsing the double-encoded inputs
// dump and stripping the `info:` level prefix, so the Log section reads as a clean run
// narrative. The load-bearing cases run over the REAL fixture bytes (both captures), so the
// transform is verified against reality, not a hand-rolled guess.

import { describe, expect, test } from "bun:test";
import { dryRunResponse } from "./__fixtures__/dryRunResponse.ts";
import { skippedDryRunResponse } from "./__fixtures__/dryRunResponseSkipped.ts";
import { stripAnsi } from "./ansi.ts";
import { denoiseLogLine } from "./dryRunLogDenoise.ts";

describe("denoiseLogLine — the inputs blob", () => {
  test("collapses the 'Running … with inputs (secrets redacted): {…}' JSON to a short note", () => {
    const line =
      'Running roadiehq:utils:jsonata in dry-run mode with inputs (secrets redacted): {\n  "data": { "x": 1 }\n} {"span_id":"0","trace_id":"0"}';
    const out = denoiseLogLine(line);
    // The prefix THROUGH the colon is kept; the JSON blob + telemetry become the note.
    expect(out).toBe(
      "Running roadiehq:utils:jsonata in dry-run mode with inputs (secrets redacted): (inputs shown above)",
    );
    expect(out).not.toContain('"data"');
    expect(out).not.toContain("span_id");
  });

  test("a line WITHOUT the inputs marker keeps its content (only the level prefix is touched)", () => {
    expect(denoiseLogLine("info: Order for Bob Baker routed")).toBe("Order for Bob Baker routed");
  });
});

describe("denoiseLogLine — the level prefix", () => {
  test("strips a leading `info:` (noise — every ordinary line is info)", () => {
    expect(denoiseLogLine("info: hello bakery")).toBe("hello bakery");
  });

  test("KEEPS and MARKS a `warn:` line (signal)", () => {
    expect(denoiseLogLine("warn: the oven is running low on flour")).toBe("⚠ warn: the oven is running low on flour");
  });

  test("KEEPS and MARKS an `error:` line (signal)", () => {
    expect(denoiseLogLine("error: the oven is cold")).toBe("✗ error: the oven is cold");
  });

  test("a line with no recognized level is returned unchanged", () => {
    expect(denoiseLogLine("Beginning step Log the incoming order")).toBe("Beginning step Log the incoming order");
  });

  test("the inputs line ALSO starts with `info:` — the blob is collapsed AND the prefix stripped", () => {
    const line =
      'info: Running debug:log in dry-run mode with inputs (secrets redacted): {"message":"hi"} {"trace_id":"0"}';
    expect(denoiseLogLine(line)).toBe(
      "Running debug:log in dry-run mode with inputs (secrets redacted): (inputs shown above)",
    );
  });
});

describe("denoiseLogLine — against the REAL fixture bytes", () => {
  /** Every log message from a captured response, ANSI-stripped (as the presenter does first). */
  function messages(body: { log: { body?: { message?: string } }[] }): string[] {
    return body.log.map((l) => stripAnsi(l.body?.message ?? ""));
  }

  test("the payload-assembly capture: every inputs dump collapses, no JSON blob survives", () => {
    const denoised = messages(dryRunResponse).map(denoiseLogLine);
    const inputsLines = denoised.filter((m) => m.includes("with inputs (secrets redacted):"));
    expect(inputsLines.length).toBeGreaterThan(0);
    for (const line of inputsLines) {
      expect(line).toContain("(inputs shown above)");
      expect(line).not.toContain("customerName"); // the double-encoded inputs JSON is gone
      expect(line).not.toContain("span_id"); // the trailing telemetry blob is gone
    }
  });

  test("the skipped capture: no `info:` prefix survives on any line, and the skip line is untouched", () => {
    const denoised = messages(skippedDryRunResponse).map(denoiseLogLine);
    expect(denoised.some((m) => m.startsWith("info:"))).toBe(false);
    // The skip signal is a plain sentence (no level prefix) — it must pass through verbatim.
    expect(denoised.some((m) => m === "Skipping step rush-ticket because its if condition was false")).toBe(true);
  });
});
