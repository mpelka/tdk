// Unit tests for the dry-run trace adapter — the normalization of a real Backstage
// dry-run response into the SAME `TraceStep[]` the local trace renders.
//
// The load-bearing case runs the ADAPTER against the CAPTURED REAL 200 response (a
// redacted, bakery-only fixture from a live local Backstage with roadiehq:utils:jsonata),
// so the design is verified against reality, not a hand-rolled guess.

import { describe, expect, test } from "bun:test";
import type { DryRunSuccessBody } from "@tdk/core/backstage";
import { dryRunParameters, dryRunResponse, dryRunSourceSteps } from "./__fixtures__/dryRunResponse.ts";
import {
  skippedDryRunParameters,
  skippedDryRunResponse,
  skippedDryRunSourceSteps,
} from "./__fixtures__/dryRunResponseSkipped.ts";
import { dryRunTraceSteps } from "./dryRunTrace.ts";

describe("dryRunTraceSteps — against the captured real response", () => {
  const { preamble, steps } = dryRunTraceSteps(dryRunResponse, dryRunSourceSteps, dryRunParameters);

  test("produces one normalized step per executed step, in order", () => {
    expect(steps.map((s) => s.id)).toEqual(["build-ticket", "log-ticket"]);
  });

  test("maps the rolled-up log status to the shared rail status (completed → ran)", () => {
    expect(steps.every((s) => s.status === "ran")).toBe(true);
  });

  test("pairs the compiled SOURCE against the RESOLVED values recovered from the log", () => {
    // build-ticket's `data.customerName` is `${{ parameters.customerName }}` in the source
    // and "Alice Baker" resolved — a templated provenance leaf under the `data` branch.
    const build = steps.find((s) => s.id === "build-ticket");
    const data = build?.provenance.find((n) => n.key === "data");
    expect(data?.kind).toBe("object");
    const customerName = data?.children?.find((n) => n.key === "customerName");
    expect(customerName?.expression).toBe("${{ parameters.customerName }}");
    expect(customerName?.value).toBe("Alice Baker");
    expect(customerName?.templated).toBe(true);
  });

  test("the second step's message input resolves through the log too", () => {
    const log = steps.find((s) => s.id === "log-ticket");
    const message = log?.provenance.find((n) => n.key === "message");
    // Source is a `${{ … }}` template; resolved value came from the log line.
    expect(message?.expression).toContain("Ticket:");
    expect(message?.value).toBe("Ticket: Order for Alice Baker — high priority (2 item(s))");
    expect(message?.templated).toBe(true);
  });

  test("each step carries its ANSI-stripped log lines (stripping happens in presentation)", () => {
    // The adapter carries the raw grouped lines; presentDryRun strips ANSI. Here we only
    // assert the lines are present + grouped to the right step.
    const build = steps.find((s) => s.id === "build-ticket");
    expect(build?.log?.some((l) => l.message.includes("Beginning step Build the order ticket"))).toBe(true);
    expect(build?.log?.some((l) => l.status === "completed")).toBe(true);
  });

  test("the preamble is the leading task-banner line", () => {
    expect(preamble[0]?.message).toContain("Starting up task with 3 steps");
  });

  test("no per-step output is fabricated (Backstage reports only the run's final output)", () => {
    expect(steps.every((s) => s.output === undefined)).toBe(true);
  });

  test("each step's context is the submitted parameters", () => {
    expect(steps[0]?.context.parameters).toEqual(dryRunParameters);
  });
});

describe("dryRunTraceSteps — edge cases", () => {
  test("a step whose log has no resolved-input line renders EXPRESSION-ONLY provenance (never guessed values)", () => {
    const body: DryRunSuccessBody = {
      steps: [{ id: "s", action: "debug:log", input: {} }],
      log: [{ body: { stepId: "s", status: "processing", message: "Beginning step s" } }],
      output: {},
      directoryContents: [],
    };
    const source = [{ id: "s", input: { message: "${{ parameters.x }}" } }];
    const { steps } = dryRunTraceSteps(body, source, { x: "unused" });
    const message = steps[0]?.provenance.find((n) => n.key === "message");
    // The expression is shown, but with no recovered value → not templated (no arrow).
    expect(message?.expression).toBe("${{ parameters.x }}");
    expect(message?.value).toBeUndefined();
    expect(message?.templated).toBeFalsy();
  });

  test("a failed step maps to the error status and carries its failed lines as the error body", () => {
    const body: DryRunSuccessBody = {
      steps: [{ id: "boom", action: "debug:log", input: {} }],
      log: [{ body: { stepId: "boom", status: "failed", message: "the oven is cold" } }],
      output: undefined,
      directoryContents: [],
    };
    const { steps } = dryRunTraceSteps(body, [], {});
    expect(steps[0]?.status).toBe("error");
    expect(steps[0]?.error).toContain("the oven is cold");
  });

  test("ECHO ATTACK: a completed step whose output echoes the skip sentence stays ran", () => {
    // Skip detection keys on the STRUCTURED `status: "skipped"` field alone (live-confirmed:
    // the real skip line always carries it). A step whose own output — e.g. a `debug:log`
    // message — echoes the literal sentence must NOT mis-mark itself as skipped.
    const body: DryRunSuccessBody = {
      steps: [{ id: "echo", action: "debug:log", input: {} }],
      log: [
        { body: { stepId: "echo", status: "processing", message: "Beginning step echo" } },
        { body: { stepId: "echo", message: "info: Skipping step echo because its if condition was false" } },
        { body: { stepId: "echo", status: "completed", message: "Finished step echo" } },
      ],
      output: {},
      directoryContents: [],
    };
    const { steps } = dryRunTraceSteps(body, [], {});
    expect(steps[0]?.status).toBe("ran");
  });
});

describe("dryRunTraceSteps — against the captured SKIPPED-step response (item #1 + #2)", () => {
  const { preamble, steps } = dryRunTraceSteps(
    skippedDryRunResponse,
    skippedDryRunSourceSteps,
    skippedDryRunParameters,
  );

  test("produces one step per executed step, in order", () => {
    expect(steps.map((s) => s.id)).toEqual(["log-order", "rush-ticket", "log-done"]);
  });

  test("the `if:`-gated step whose condition was false is marked SKIPPED (⤼), not ran (✓)", () => {
    // The fidelity bug: before, a skipped step rolled up to `processing` → the wrong ✓. The
    // scaffolder's own `Skipping step … because its if condition was false` line marks it.
    const rush = steps.find((s) => s.id === "rush-ticket");
    expect(rush?.status).toBe("skipped");
    // The steps that DID run are still ✓.
    expect(steps.find((s) => s.id === "log-order")?.status).toBe("ran");
    expect(steps.find((s) => s.id === "log-done")?.status).toBe("ran");
  });

  test("the skipped step renders EXPRESSION-ONLY provenance — never a fabricated `undefined` value", () => {
    // A skipped step emits NO "Running … with inputs" line, so nothing resolves. Its input
    // must show its SOURCE expression alone (no value, not templated) — the never-guess rule.
    const rush = steps.find((s) => s.id === "rush-ticket");
    const message = rush?.provenance.find((n) => n.key === "message");
    expect(message?.expression).toContain("RUSH ticket raised for");
    expect(message?.value).toBeUndefined();
    expect(message?.templated).toBeFalsy();
  });

  test("the steps that DID run still resolve their inputs through the log", () => {
    const logOrder = steps.find((s) => s.id === "log-order");
    const message = logOrder?.provenance.find((n) => n.key === "message");
    expect(message?.value).toBe("Order for Bob Baker (normal priority)");
    expect(message?.templated).toBe(true);
  });

  test("the real skip line rides in the skipped step's Log (the reason is never lost)", () => {
    const rush = steps.find((s) => s.id === "rush-ticket");
    expect(rush?.log?.some((l) => l.message.includes("Skipping step rush-ticket"))).toBe(true);
  });

  test("the banner counts one MORE step than the rail (the implicit scaffolder step) — see item #6", () => {
    // "Starting up task with 4 steps" while only 3 template steps exist: the scaffolder
    // counts an implicit trailing step. It emits no log line, so nothing is dropped; the
    // banner still surfaces in the preamble/run-log so the count is never hidden.
    expect(preamble.some((l) => l.message.includes("Starting up task with 4 steps"))).toBe(true);
    expect(steps).toHaveLength(3);
  });
});
