import { describe, expect, test } from "bun:test";
import type { DryRunResult } from "@tdk/core/backstage";
import type { DryRunEndpoint } from "../webview/protocol.ts";
import type { SourceStep } from "./buildTrace.ts";
import { dryRunEndpoint, flattenValidationError, presentDryRun } from "./dryRunPresentation.ts";

/** A fake base64 decode (identity-ish) so the test doesn't depend on a real codec. */
const fakeDecode = (b64: string) => `decoded(${b64})`;

/** A stub endpoint header line for the arms that don't assert on it. */
const endpoint: DryRunEndpoint = { baseUrl: "http://localhost:7007", status: "200", durationMs: 12 };

/** Empty presentation context (no source steps / parameters) for arms that don't need provenance. */
const noCtx = { sourceSteps: [] as SourceStep[], parameters: {} };

/** The ESC control character, spelled as an escape so the source carries no raw control byte. */
const ESC = String.fromCharCode(27);

describe("presentDryRun — ok", () => {
  const okResult: DryRunResult = {
    kind: "ok",
    body: {
      steps: [
        { id: "log", name: "Log", action: "debug:log", input: { message: "hi" } },
        { id: "write", name: "Write", action: "fs:write", input: { path: "recipe.txt" } },
      ],
      log: [
        { body: { message: "Starting up task with 2 steps" } },
        { body: { stepId: "log", status: "processing", message: "Beginning step Log" } },
        { body: { stepId: "log", status: "completed", message: "Finished step Log" } },
        { body: { stepId: "write", status: "completed", message: "Finished step Write" } },
      ],
      output: { links: [] },
      directoryContents: [{ path: "recipe.txt", executable: false, base64Content: "ZmxvdXI=" }],
    },
  };

  test("normalizes into TraceStep[], carries preamble, output, decoded files, and the endpoint", () => {
    const msg = presentDryRun(okResult, "Cake Order", endpoint, noCtx, fakeDecode);
    expect(msg.kind).toBe("ok");
    expect(msg.endpoint).toEqual(endpoint);
    expect(msg.preamble?.map((l) => l.message)).toEqual(["Starting up task with 2 steps"]);
    expect(msg.steps).toHaveLength(2);
    // The steps are the SHARED trace shape now — completed → ran, a per-step `log`.
    expect(msg.steps?.[0]?.id).toBe("log");
    expect(msg.steps?.[0]?.status).toBe("ran");
    expect(msg.steps?.[0]?.log).toHaveLength(2);
    expect(msg.output).toEqual({ links: [] });
    expect(msg.files).toHaveLength(1);
    expect(msg.files?.[0]?.path).toBe("recipe.txt");
    expect(msg.files?.[0]?.content).toBe("decoded(ZmxvdXI=)");
    expect(msg.files?.[0]?.executable).toBe(false);
    expect(msg.title).toBe("Cake Order");
  });

  test("a failed step maps to the error status and carries its failed lines as the error body", () => {
    const failing: DryRunResult = {
      kind: "ok",
      body: {
        steps: [{ id: "boom", action: "debug:log", input: {} }],
        log: [{ body: { stepId: "boom", status: "failed", message: "who required" } }],
        output: undefined,
        directoryContents: [],
      },
    };
    const msg = presentDryRun(failing, "t", endpoint, noCtx, fakeDecode);
    expect(msg.steps?.[0]?.status).toBe("error");
    expect(msg.steps?.[0]?.error).toContain("who required");
  });

  test("strips ANSI escape codes from the log lines AND de-noises the info: level prefix", () => {
    const coloured: DryRunResult = {
      kind: "ok",
      body: {
        steps: [{ id: "log", action: "debug:log", input: {} }],
        // A coloured line as Backstage emits it: ESC[32m … ESC[39m around "info".
        log: [{ body: { stepId: "log", message: `${ESC}[32minfo${ESC}[39m: hello bakery` } }],
        output: {},
        directoryContents: [],
      },
    };
    const msg = presentDryRun(coloured, "t", endpoint, noCtx, fakeDecode);
    // ANSI stripped, and the (noise) `info:` level prefix dropped by the de-noiser (item #3).
    expect(msg.steps?.[0]?.log?.[0]?.message).toBe("hello bakery");
    expect(msg.steps?.[0]?.log?.[0]?.message).not.toContain(ESC);
  });

  test("an empty directoryContents yields an empty files array (the view shows a quiet no-files state)", () => {
    const msg = presentDryRun(
      { ...okResult, body: { ...okResult.body, directoryContents: [] } },
      "t",
      endpoint,
      noCtx,
      fakeDecode,
    );
    expect(msg.files).toEqual([]);
  });

  test("a decode failure degrades to a visible placeholder, never throws", () => {
    const throwingDecode = () => {
      throw new Error("bad base64");
    };
    const msg = presentDryRun(okResult, "t", endpoint, noCtx, throwingDecode);
    expect(msg.files?.[0]?.content).toContain("could not decode");
  });
});

describe("presentDryRun — validationFailed", () => {
  test("flattens each error to { where, message } and carries the endpoint", () => {
    const result: DryRunResult = {
      kind: "validationFailed",
      errors: [
        { path: [], property: "instance", message: 'requires property "flavor"', name: "required", argument: "flavor" },
      ],
    };
    const msg = presentDryRun(result, "t", endpoint, noCtx, fakeDecode);
    expect(msg.kind).toBe("validationFailed");
    expect(msg.endpoint).toEqual(endpoint);
    expect(msg.errors).toHaveLength(1);
    expect(msg.errors?.[0]?.where).toBe("flavor");
    expect(msg.errors?.[0]?.message).toContain("flavor");
  });
});

describe("presentDryRun — authFailed / error", () => {
  test("authFailed carries the client message under kind authFailed", () => {
    const msg = presentDryRun(
      { kind: "authFailed", status: 401, message: "rejected — set token" },
      "t",
      endpoint,
      noCtx,
      fakeDecode,
    );
    expect(msg.kind).toBe("authFailed");
    expect(msg.message).toContain("set token");
  });

  test("serverError becomes an error line naming the status", () => {
    const msg = presentDryRun({ kind: "serverError", status: 500, message: "boom" }, "t", endpoint, noCtx, fakeDecode);
    expect(msg.kind).toBe("error");
    expect(msg.message).toContain("500");
    expect(msg.message).toContain("boom");
  });

  test("unreachable becomes an error line carrying the client message", () => {
    const msg = presentDryRun(
      { kind: "unreachable", message: "could not reach http://x" },
      "t",
      endpoint,
      noCtx,
      fakeDecode,
    );
    expect(msg.kind).toBe("error");
    expect(msg.message).toContain("could not reach");
  });
});

describe("dryRunEndpoint — the slot header status", () => {
  test("an ok result reports 200", () => {
    expect(
      dryRunEndpoint({ kind: "ok", body: { steps: [], log: [], output: {}, directoryContents: [] } }, "u", 5),
    ).toEqual({ baseUrl: "u", status: "200", durationMs: 5 });
  });
  test("a validationFailed reports 400", () => {
    expect(dryRunEndpoint({ kind: "validationFailed", errors: [] }, "u", 5).status).toBe("400");
  });
  test("authFailed / serverError report their HTTP status", () => {
    expect(dryRunEndpoint({ kind: "authFailed", status: 401, message: "" }, "u", 5).status).toBe("401");
    expect(dryRunEndpoint({ kind: "serverError", status: 500, message: "" }, "u", 5).status).toBe("500");
  });
  test("unreachable reports the taxonomy label instead of a status", () => {
    expect(dryRunEndpoint({ kind: "unreachable", message: "" }, "u", 5).status).toBe("unreachable");
  });
});

describe("flattenValidationError — location", () => {
  test("required uses the argument (the offending property)", () => {
    expect(flattenValidationError({ message: "m", name: "required", argument: "flavor" }).where).toBe("flavor");
  });
  test("a nested path joins with dots", () => {
    expect(flattenValidationError({ message: "m", name: "type", path: ["items", 0, "qty"] }).where).toBe("items.0.qty");
  });
  test("a bare instance root falls back to 'root'", () => {
    expect(flattenValidationError({ message: "m", property: "instance", path: [] }).where).toBe("root");
  });
  test("a non-instance property is used when there is no path", () => {
    expect(flattenValidationError({ message: "m", property: "flavor" }).where).toBe("flavor");
  });
});

describe("verifier regression on #69 — file content cap", () => {
  test("a file past 512 KB truncates LOUDLY, a small file passes through verbatim", () => {
    const big = "x".repeat(600 * 1024);
    const result = presentDryRun(
      {
        kind: "ok",
        body: {
          steps: [],
          log: [],
          output: {},
          directoryContents: [
            { path: "big.txt", executable: false, base64Content: Buffer.from(big).toString("base64") },
            { path: "small.txt", executable: false, base64Content: Buffer.from("tiny").toString("base64") },
          ],
        },
      },
      "T",
      endpoint,
      noCtx,
      (b) => Buffer.from(b, "base64").toString("utf8"),
    );
    if (result.kind !== "ok" || !result.files) throw new Error("expected ok with files");
    expect(result.files[0]!.content).toContain("truncated: big.txt");
    expect(result.files[0]!.content.length).toBeLessThan(big.length);
    expect(result.files[1]!.content).toBe("tiny");
  });
});
