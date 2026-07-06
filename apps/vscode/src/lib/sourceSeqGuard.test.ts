// Unit tests for the per-source latest-wins guard — the sequencing that keeps a stale
// run from clobbering a fresher one, per source, without the two sources racing.

import { describe, expect, test } from "bun:test";
import { createSourceSeqGuard } from "./sourceSeqGuard.ts";

describe("createSourceSeqGuard", () => {
  test("a single run's token is the latest until a newer run of the SAME source is stamped", () => {
    const g = createSourceSeqGuard();
    const a = g.stamp("local");
    expect(g.isLatest("local", a)).toBe(true);
    const b = g.stamp("local");
    // The older token is no longer latest; the newer one is.
    expect(g.isLatest("local", a)).toBe(false);
    expect(g.isLatest("local", b)).toBe(true);
  });

  test("a SLOW older local run resolving after a newer one is NOT latest (no clobber)", () => {
    const g = createSourceSeqGuard();
    const slow = g.stamp("local"); // started first
    const fast = g.stamp("local"); // started second, resolves first
    // The fast one posts…
    expect(g.isLatest("local", fast)).toBe(true);
    // …and when the slow one finally resolves, its token is stale.
    expect(g.isLatest("local", slow)).toBe(false);
  });

  test("the two sources NEVER clobber each other — independent counters", () => {
    const g = createSourceSeqGuard();
    const localTok = g.stamp("local");
    const dryRunTok = g.stamp("dryRun");
    // Stamping a dry-run does not invalidate the pending local run…
    expect(g.isLatest("local", localTok)).toBe(true);
    // …and stamping a local run does not invalidate the pending dry-run.
    const local2 = g.stamp("local");
    expect(g.isLatest("dryRun", dryRunTok)).toBe(true);
    expect(g.isLatest("local", localTok)).toBe(false);
    expect(g.isLatest("local", local2)).toBe(true);
  });

  test("each source starts at its own zero and counts independently", () => {
    const g = createSourceSeqGuard();
    expect(g.stamp("local")).toBe(1);
    expect(g.stamp("local")).toBe(2);
    expect(g.stamp("dryRun")).toBe(1); // dry-run's own counter, not continuing local's
  });
});
