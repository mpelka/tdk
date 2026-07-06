// Unit tests for recovering a dry-run step's resolved input from its run log — the
// best-effort half of the dry-run provenance pairing.

import { describe, expect, test } from "bun:test";
import { resolvedInputFromLog } from "./dryRunResolvedInput.ts";

/** ESC, built from its code so the source carries no raw control byte. */
const ESC = String.fromCharCode(27);

describe("resolvedInputFromLog", () => {
  test("extracts the resolved input JSON from a real 'Running … with inputs' line", () => {
    const line = `${ESC}[32minfo${ESC}[39m: Running debug:log in dry-run mode with inputs (secrets redacted): {\n  "message": "Ticket: Order for Alice Baker"\n} {"span_id":"0","trace_id":"0"}`;
    expect(resolvedInputFromLog([line])).toEqual({ message: "Ticket: Order for Alice Baker" });
  });

  test("ignores the TRAILING telemetry blob (a second {…} after the input)", () => {
    // The input has a nested object; only the FIRST balanced object is the input.
    const line = `Running roadiehq:utils:jsonata in dry-run mode with inputs (secrets redacted): {"data":{"customerName":"Alice Baker"}} {"span_id":"0","trace_id":"0"}`;
    expect(resolvedInputFromLog([line])).toEqual({ data: { customerName: "Alice Baker" } });
  });

  test("respects braces inside string values (a `}` in a value does not close the object early)", () => {
    const line = `Running debug:log in dry-run mode with inputs (secrets redacted): {"message":"a } brace in a value"} {"trace_id":"0"}`;
    expect(resolvedInputFromLog([line])).toEqual({ message: "a } brace in a value" });
  });

  test("scans multiple lines and returns the first that carries the marker", () => {
    const lines = [
      "Beginning step Log the assembled ticket",
      `Running debug:log in dry-run mode with inputs (secrets redacted): {"message":"hi"} {"trace_id":"0"}`,
      "Finished step Log the assembled ticket",
    ];
    expect(resolvedInputFromLog(lines)).toEqual({ message: "hi" });
  });

  test("returns undefined when no line carries the marker (→ expression-only provenance)", () => {
    expect(resolvedInputFromLog(["Beginning step Log", "Finished step Log"])).toBeUndefined();
  });

  test("returns undefined on a malformed JSON blob — never a guess", () => {
    const line = "Running debug:log in dry-run mode with inputs (secrets redacted): {not valid json";
    expect(resolvedInputFromLog([line])).toBeUndefined();
  });

  test("NEVER latches onto the trailing telemetry blob when the input is malformed-but-not-a-brace", () => {
    // The input after the marker is garbage that is NOT a `{`, while the telemetry blob at
    // the end of the line is perfectly valid JSON. A lenient "find the next `{`" would
    // return the TELEMETRY as the resolved input — the object must start immediately after
    // the marker (whitespace only), else undefined.
    const line = `Running debug:log in dry-run mode with inputs (secrets redacted): not-json-here {"span_id":"0000000000000000","trace_id":"00000000000000000000000000000000"}`;
    expect(resolvedInputFromLog([line])).toBeUndefined();
  });
});
