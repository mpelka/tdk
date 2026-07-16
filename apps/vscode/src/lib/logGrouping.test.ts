import { describe, expect, test } from "bun:test";
import type { DryRunLogEntry, DryRunStep } from "@tdk/core/backstage";
import { groupLog } from "./logGrouping.ts";

/** A step-scoped log entry. */
function line(stepId: string | undefined, message: string, status?: string): DryRunLogEntry {
  return { body: { stepId, status, message } };
}

const steps: DryRunStep[] = [
  { id: "log", name: "Log", action: "debug:log", input: { message: "hi" } },
  { id: "write", name: "Write", action: "fs:write", input: { path: "recipe.txt" } },
];

describe("groupLog", () => {
  test("leading stepId-less lines become the preamble", () => {
    const log = [line(undefined, "Starting up task with 2 steps"), line("log", "Beginning step Log", "processing")];
    const grouped = groupLog(log, steps);
    expect(grouped.preamble.map((l) => l.message)).toEqual(["Starting up task with 2 steps"]);
    expect(grouped.steps[0]?.lines.map((l) => l.message)).toEqual(["Beginning step Log"]);
  });

  test("lines bucket by stepId in step order, with metadata paired on", () => {
    const log = [
      line(undefined, "banner"),
      line("log", "Beginning step Log", "processing"),
      line("log", "info: hi"),
      line("log", "Finished step Log", "completed"),
      line("write", "Beginning step Write", "processing"),
      line("write", "Finished step Write", "completed"),
    ];
    const grouped = groupLog(log, steps);
    expect(grouped.steps).toHaveLength(2);
    expect(grouped.steps[0]?.id).toBe("log");
    expect(grouped.steps[0]?.name).toBe("Log");
    expect(grouped.steps[0]?.action).toBe("debug:log");
    expect(grouped.steps[0]?.lines).toHaveLength(3);
    expect(grouped.steps[1]?.id).toBe("write");
    expect(grouped.steps[1]?.lines).toHaveLength(2);
  });

  test("a step's status rolls up: completed when its last status is completed", () => {
    const log = [line("log", "Beginning", "processing"), line("log", "Finished", "completed")];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.steps[0]?.status).toBe("completed");
  });

  test("failed wins over everything", () => {
    const log = [line("log", "Beginning", "processing"), line("log", "boom", "failed"), line("log", "more")];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.steps[0]?.status).toBe("failed");
  });

  test("a skip line (status `skipped`) rolls up to `skipped`, outranking the leading `processing`", () => {
    // The exact fidelity-bug shape: a skipped step emits `Beginning step …` (processing)
    // THEN a `skipped` line. Without the skip outranking processing it would roll up to
    // `processing` → the wrong ✓ glyph downstream.
    const log = [
      line("log", "Beginning step Log", "processing"),
      line("log", "Skipping step log because its if condition was false", "skipped"),
    ];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.steps[0]?.status).toBe("skipped");
  });

  test("ECHO ATTACK: a completed step whose own output echoes the skip sentence stays completed", () => {
    // Detection keys on the STRUCTURED status field, never the message text — a step whose
    // debug output happens to contain the literal skip sentence must NOT mis-mark itself
    // as skipped (wrong glyph, wrong note, expression-only inputs on a step that ran).
    const log = [
      line("log", "Beginning step Log", "processing"),
      line("log", "info: Skipping step log because its if condition was false"),
      line("log", "Finished step Log", "completed"),
    ];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.steps[0]?.status).toBe("completed");
  });

  test("failed still wins over a skip (an error is the more urgent signal)", () => {
    const log = [
      line("log", "Skipping step log because its if condition was false", "skipped"),
      line("log", "boom", "failed"),
    ];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.steps[0]?.status).toBe("failed");
  });

  test("a step with no log lines still appears (empty lines, unknown status)", () => {
    const log = [line("log", "only the log step ran", "completed")];
    const grouped = groupLog(log, steps);
    expect(grouped.steps).toHaveLength(2);
    expect(grouped.steps[1]?.id).toBe("write");
    expect(grouped.steps[1]?.lines).toEqual([]);
    expect(grouped.steps[1]?.status).toBe("unknown");
  });

  test("a line whose stepId matches no executed step becomes an orphan (never dropped)", () => {
    const log = [line("log", "ok", "completed"), line("ghost", "who am I", "processing")];
    const grouped = groupLog(log, [steps[0]!]);
    expect(grouped.orphans.map((l) => l.message)).toEqual(["who am I"]);
    expect(grouped.steps[0]?.lines).toHaveLength(1);
  });

  test("an all-preamble log (no step-scoped lines) leaves every step empty", () => {
    const log = [line(undefined, "a"), line(undefined, "b")];
    const grouped = groupLog(log, steps);
    expect(grouped.preamble).toHaveLength(2);
    expect(grouped.steps.every((s) => s.lines.length === 0)).toBe(true);
  });

  test("a message-less entry flattens to an empty string, not undefined", () => {
    const grouped = groupLog([{ body: { stepId: "log" } }], [steps[0]!]);
    expect(grouped.steps[0]?.lines[0]?.message).toBe("");
  });
});
