// Unit tests for the dry-run RUN HISTORY model (item #4) — the pure cap/append/navigate/
// label reducer behind the run indicator, plus `recordCompletedRun`, the seam behind the
// form preview's dry-run emit. The recordCompletedRun cases drive the REAL seq guard so the
// two lost-run race triggers (a rapid resubmit; a ‹ › navigation mid-flight) are pinned at
// the extension side, not just the view.

import { describe, expect, test } from "bun:test";
import type { DryRunTraceMessage } from "../webview/protocol.ts";
import {
  appendRun,
  appendRunPreservingSelection,
  DRY_RUN_HISTORY_CAP,
  type DryRunHistoryEntry,
  emptyHistory,
  historyView,
  navigate,
  outcomeLabel,
  recordCompletedRun,
  selectedEntry,
  selectRun,
  tagSelected,
} from "./dryRunHistory.ts";
import { createSourceSeqGuard } from "./sourceSeqGuard.ts";

/** A completed dry-run message of a given kind, with a distinguishing baseUrl status. */
function message(kind: DryRunTraceMessage["kind"], tag = "x"): DryRunTraceMessage {
  return {
    type: "dryRunResult",
    kind,
    endpoint: { baseUrl: `http://${tag}`, status: "200", durationMs: 1 },
  };
}

/** A history entry wrapping a message, timestamp, and its taxonomy label. */
function entry(kind: DryRunTraceMessage["kind"], timestamp: number, tag = "x"): DryRunHistoryEntry {
  const msg = message(kind, tag);
  return { message: msg, timestamp, label: outcomeLabel(msg) };
}

describe("dryRunHistory — append + select", () => {
  test("a fresh history is empty with no selection", () => {
    const h = emptyHistory();
    expect(h.entries).toEqual([]);
    expect(h.selected).toBe(-1);
    expect(selectedEntry(h)).toBeUndefined();
  });

  test("appending a run auto-selects it as the latest", () => {
    let h = emptyHistory();
    h = appendRun(h, entry("ok", 100));
    expect(h.entries).toHaveLength(1);
    expect(h.selected).toBe(0);
    h = appendRun(h, entry("ok", 200));
    expect(h.entries).toHaveLength(2);
    expect(h.selected).toBe(1); // auto-shows the newest
    expect(selectedEntry(h)?.timestamp).toBe(200);
  });

  test("append is PURE — it never mutates the input history", () => {
    const h0 = emptyHistory();
    const h1 = appendRun(h0, entry("ok", 100));
    expect(h0.entries).toHaveLength(0); // untouched
    expect(h1.entries).toHaveLength(1);
  });
});

describe("dryRunHistory — the cap", () => {
  test(`keeps only the newest ${DRY_RUN_HISTORY_CAP} runs, dropping the oldest`, () => {
    let h = emptyHistory();
    for (let i = 0; i < DRY_RUN_HISTORY_CAP + 5; i++) h = appendRun(h, entry("ok", i));
    expect(h.entries).toHaveLength(DRY_RUN_HISTORY_CAP);
    // The oldest 5 (timestamps 0..4) fell off; the newest is still selected.
    expect(h.entries[0]?.timestamp).toBe(5);
    expect(h.selected).toBe(DRY_RUN_HISTORY_CAP - 1);
    expect(selectedEntry(h)?.timestamp).toBe(DRY_RUN_HISTORY_CAP + 4);
  });
});

describe("dryRunHistory — navigation", () => {
  test("‹ prev moves to an OLDER run, › next to a NEWER one, clamped at the ends", () => {
    let h = emptyHistory();
    h = appendRun(h, entry("ok", 1));
    h = appendRun(h, entry("ok", 2));
    h = appendRun(h, entry("ok", 3)); // selected = 2 (newest)
    h = navigate(h, "prev");
    expect(h.selected).toBe(1);
    h = navigate(h, "prev");
    expect(h.selected).toBe(0);
    h = navigate(h, "prev"); // clamped at the oldest
    expect(h.selected).toBe(0);
    h = navigate(h, "next");
    expect(h.selected).toBe(1);
    h = navigate(h, "next");
    expect(h.selected).toBe(2);
    h = navigate(h, "next"); // clamped at the newest
    expect(h.selected).toBe(2);
  });

  test("navigating an empty history is a no-op", () => {
    const h = navigate(emptyHistory(), "prev");
    expect(h.selected).toBe(-1);
  });

  test("selectRun clamps an out-of-range index into the valid window", () => {
    let h = emptyHistory();
    h = appendRun(h, entry("ok", 1));
    h = appendRun(h, entry("ok", 2));
    expect(selectRun(h, 99).selected).toBe(1);
    expect(selectRun(h, -5).selected).toBe(0);
  });
});

describe("dryRunHistory — taxonomy labels", () => {
  test("each entry is labeled by the run's outcome kind (a failed run reads as what it was)", () => {
    let h = emptyHistory();
    h = appendRun(h, entry("ok", 1));
    h = appendRun(h, entry("validationFailed", 2));
    h = appendRun(h, entry("authFailed", 3));
    h = appendRun(h, entry("error", 4));
    expect(h.entries.map((e) => e.label)).toEqual(["ok", "validationFailed", "authFailed", "error"]);
  });

  test("outcomeLabel maps each message kind to its label", () => {
    expect(outcomeLabel(message("ok"))).toBe("ok");
    expect(outcomeLabel(message("validationFailed"))).toBe("validationFailed");
    expect(outcomeLabel(message("authFailed"))).toBe("authFailed");
    expect(outcomeLabel(message("error"))).toBe("error");
  });
});

describe("dryRunHistory — appendRunPreservingSelection (the stale-run arm)", () => {
  test("appends without moving an existing selection", () => {
    let h = emptyHistory();
    h = appendRun(h, entry("ok", 1, "r1"));
    h = appendRun(h, entry("ok", 2, "r2")); // selected = 1
    h = navigate(h, "prev"); // selected = 0
    h = appendRunPreservingSelection(h, entry("ok", 3, "r3"));
    expect(h.entries).toHaveLength(3);
    expect(h.selected).toBe(0); // still the run the user was viewing
    expect(selectedEntry(h)?.timestamp).toBe(1);
  });

  test("with NO selection (-1), the append leaves none selected (a pending run stays the display)", () => {
    const h = appendRunPreservingSelection(emptyHistory(), entry("ok", 1));
    expect(h.entries).toHaveLength(1);
    expect(h.selected).toBe(-1);
    expect(selectedEntry(h)).toBeUndefined();
    expect(tagSelected(h)).toBeUndefined(); // nothing to (re)show — the pending stays
  });

  test("a cap overflow shifts the preserved selection down with the dropped entries", () => {
    let h = emptyHistory();
    for (let i = 0; i < DRY_RUN_HISTORY_CAP; i++) h = appendRun(h, entry("ok", i));
    h = selectRun(h, 5); // viewing an older run
    h = appendRunPreservingSelection(h, entry("ok", 100));
    expect(h.entries).toHaveLength(DRY_RUN_HISTORY_CAP);
    // One entry fell off the front, so the same RUN now sits one index lower.
    expect(h.selected).toBe(4);
    expect(selectedEntry(h)?.timestamp).toBe(5);
  });

  test("when the selected entry itself falls off, the selection clamps at the new oldest", () => {
    let h = emptyHistory();
    for (let i = 0; i < DRY_RUN_HISTORY_CAP; i++) h = appendRun(h, entry("ok", i));
    h = selectRun(h, 0); // viewing the OLDEST run
    h = appendRunPreservingSelection(h, entry("ok", 100));
    expect(h.selected).toBe(0); // clamped — the new oldest
    expect(selectedEntry(h)?.timestamp).toBe(1);
  });
});

describe("dryRunHistory — recordCompletedRun against the REAL seq guard (the formPreview seam)", () => {
  test("(a) two rapid submits: BOTH runs land in history, the latest is shown", () => {
    // The lost-run race: run A is in flight when submit B re-stamps the dry-run source. A's
    // completion is STALE for display — but it must still be RECORDED (the user paid
    // Backstage for it); only its auto-show is suppressed.
    const guard = createSourceSeqGuard();
    let history = emptyHistory();
    const seqA = guard.stamp("dryRun"); // submit A
    const seqB = guard.stamp("dryRun"); // submit B re-stamps while A is in flight
    // A completes STALE — appended, never shown.
    const a = recordCompletedRun(history, message("ok", "run-a"), 100, guard.isLatest("dryRun", seqA));
    history = a.history;
    expect(a.show).toBeUndefined();
    expect(history.entries).toHaveLength(1); // run A is NOT lost
    // No run is selected yet (the slot shows B's pending) — no indicator to refresh either.
    expect(a.indicatorUpdate).toBeUndefined();
    // B completes LATEST — appended AND shown, with the truthful count including A.
    const b = recordCompletedRun(history, message("ok", "run-b"), 200, guard.isLatest("dryRun", seqB));
    history = b.history;
    expect(history.entries.map((e) => e.message.endpoint.baseUrl)).toEqual(["http://run-a", "http://run-b"]);
    expect(b.show?.endpoint.baseUrl).toBe("http://run-b");
    expect(b.show?.history).toMatchObject({ index: 1, total: 2 });
  });

  test("(b) navigate during flight: the in-flight run still appends, the navigated run stays shown, the count refreshes", () => {
    const guard = createSourceSeqGuard();
    let history = emptyHistory();
    // Two completed runs already in history (both latest at their time).
    history = recordCompletedRun(history, message("ok", "r1"), 1, true).history;
    history = recordCompletedRun(history, message("ok", "r2"), 2, true).history;
    // Run 3 goes in flight…
    const seq3 = guard.stamp("dryRun");
    // …and the user hits ‹ — navigateDryRun re-stamps the source and selects the older run.
    guard.stamp("dryRun");
    history = navigate(history, "prev"); // selected r1 (index 0), shown as "Run 1 of 2"
    // Run 3 completes STALE: appended, the navigated run stays selected + shown, and the
    // indicator refreshes to the truthful total.
    const r3 = recordCompletedRun(history, message("ok", "r3"), 3, guard.isLatest("dryRun", seq3));
    history = r3.history;
    expect(history.entries).toHaveLength(3); // run 3 is NOT lost
    expect(history.selected).toBe(0); // still the navigated run
    expect(r3.show).toBeUndefined(); // never clobbers the shown run
    expect(r3.indicatorUpdate).toMatchObject({ index: 0, total: 3 }); // "Run 1 of 3" now truthful
    // The focus-switch replay path reflects the fresh total too.
    expect(tagSelected(history)?.history).toMatchObject({ index: 0, total: 3 });
    expect(tagSelected(history)?.endpoint.baseUrl).toBe("http://r1");
  });

  test("a stored entry never carries a stale embedded history view (it is re-tagged per post)", () => {
    let history = emptyHistory();
    // A message arriving WITH a history view (shouldn't happen, but defensively) is stored bare.
    const tagged: DryRunTraceMessage = {
      ...message("ok"),
      history: { index: 9, total: 9, timestamp: 0, label: "ok" },
    };
    history = recordCompletedRun(history, tagged, 1, true).history;
    expect(history.entries[0]?.message.history).toBeUndefined();
    expect(historyView(history)).toMatchObject({ index: 0, total: 1 });
  });
});
