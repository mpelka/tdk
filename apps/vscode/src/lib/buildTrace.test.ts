// Unit tests for buildTraceSteps — the pure enrichment that turns a resolved run +
// compiled source steps into the trace view's per-step model (status, provenance,
// context). Covers status mapping, id-matched provenance, and the prior-outputs
// context accumulation.

import { describe, expect, test } from "bun:test";
import { buildTraceSteps, type ResolvedStep, type SourceStep } from "./buildTrace.ts";

describe("buildTraceSteps", () => {
  test("maps status: ran / skipped / error / notReached from the resolved flags", () => {
    const resolved: ResolvedStep[] = [
      { id: "a", input: {}, output: 1 },
      { id: "b", input: {}, output: undefined, skipped: true },
      { id: "c", input: {}, output: undefined, error: "boom" },
      { id: "d", input: undefined, output: undefined, notReached: true },
    ];
    const steps = buildTraceSteps(resolved, [], {});
    expect(steps.map((s) => s.status)).toEqual(["ran", "skipped", "error", "notReached"]);
  });

  test("a notReached step has NO provenance (it never ran, so there is nothing to pair)", () => {
    // Even if a source input existed for its id, the step never ran — no input to pair.
    const source: SourceStep[] = [{ id: "after", input: { message: "${{ parameters.x }}" } }];
    const resolved: ResolvedStep[] = [{ id: "after", input: undefined, output: undefined, notReached: true }];
    const steps = buildTraceSteps(resolved, source, { x: "unused" });
    expect(steps[0]?.status).toBe("notReached");
    expect(steps[0]?.provenance).toEqual([]);
    expect(steps[0]?.input).toBeUndefined();
    expect(steps[0]?.output).toBeUndefined();
  });

  test("pairs each step's compiled source input with its resolved input, matched by id", () => {
    const source: SourceStep[] = [{ id: "log-order", input: { message: "Order type: ${{ parameters.orderType }}" } }];
    const resolved: ResolvedStep[] = [{ id: "log-order", input: { message: "Order type: standard" }, output: {} }];
    const steps = buildTraceSteps(resolved, source, { orderType: "standard" });

    const prov = steps[0]?.provenance ?? [];
    expect(prov).toHaveLength(1);
    expect(prov[0]).toMatchObject({
      key: "message",
      expression: "Order type: ${{ parameters.orderType }}",
      value: "Order type: standard",
      templated: true,
    });
  });

  test("a resolved step with no matching source pairs against {} — values as literals", () => {
    const resolved: ResolvedStep[] = [{ id: "orphan", input: { ovenId: "oven-7" }, output: {} }];
    const steps = buildTraceSteps(resolved, [], {});
    expect(steps[0]?.provenance[0]).toMatchObject({ key: "ovenId", value: "oven-7" });
    expect(steps[0]?.provenance[0]?.expression).toBeUndefined();
  });

  test("context at each step is the run's parameters only (no prior-steps subtree)", () => {
    const resolved: ResolvedStep[] = [
      { id: "first", input: {}, output: { ovenId: "oven-7" } },
      { id: "second", input: {}, output: { logged: true } },
      { id: "third", input: {}, output: 3 },
    ];
    const params = { orderType: "standard" };
    const steps = buildTraceSteps(resolved, [], params);

    // Every step's context is just the parameters — prior outputs live on the rail now,
    // so the old `steps (N prior)` subtree is gone from the context entirely.
    expect(steps[0]?.context).toEqual({ parameters: params });
    expect(steps[1]?.context).toEqual({ parameters: params });
    expect(steps[2]?.context).toEqual({ parameters: params });
    for (const s of steps) expect(s.context).not.toHaveProperty("steps");
  });

  test("an empty run yields no steps", () => {
    expect(buildTraceSteps([], [], {})).toEqual([]);
  });
});
