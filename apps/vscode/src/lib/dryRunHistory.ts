// The dry-run RUN HISTORY model — the pure core behind item #4 (Backstage's template editor
// keeps a list of submitted dry-runs you can flip between; we replicate it lightly).
//
// THE MODEL. A capped, append-only list of COMPLETED dry-run results (success OR failure),
// each an entry carrying its normalized presentation message + a timestamp + the run's
// taxonomy label. A new dry-run APPENDS and auto-selects the latest; the user navigates with
// ‹ › (prev/older, next/newer) or jumps to an absolute index. Past the cap (20) the OLDEST
// entries fall off — a long session never grows unbounded.
//
// WHY EXTENSION-SIDE + PURE. The history lives per-preview in the extension host (it survives
// tab flips and focus switches, and is cleared when the preview is disposed — none of which
// the webview can own). Keeping the list + navigation logic as a pure, dependency-free
// reducer makes the cap/append/navigate/label behavior unit-testable without a live host; the
// extension just holds the state and posts the SELECTED entry through its seq-guarded path.
//
// NAVIGATION vs the SEQ GUARD. A navigation is a fresh post that must stamp the dry-run
// source anew (like a real dry-run does), so a slow in-flight dry-run resolving later cannot
// clobber the run the user navigated to — the guard's latest-wins rule handles it uniformly
// (see formPreview's `submitDryRun`). This module owns only WHICH entry is selected; the
// extension owns the stamping.

import type { DryRunHistoryView, DryRunTraceMessage } from "../webview/protocol.ts";

/** The most COMPLETED dry-run results one preview retains — older ones fall off the front. */
export const DRY_RUN_HISTORY_CAP = 20;

/**
 * A short taxonomy LABEL for a completed run, shown in the run indicator so a FAILED run in
 * history reads as what it was (not a bare "Run 3"). Mirrors the client taxonomy: an `ok`
 * result is "ok"; the failure arms carry their `kind` (the `error` kind covers both the
 * serverError and unreachable arms — the presentation already collapsed them).
 */
export type DryRunOutcomeLabel = "ok" | "validationFailed" | "authFailed" | "error";

/** One completed dry-run in the history: its normalized message, when it ran, and its label. */
export interface DryRunHistoryEntry {
  /** The normalized presentation message — replayed verbatim into the dry-run slot. */
  message: DryRunTraceMessage;
  /** Epoch millis when the run COMPLETED (the indicator renders it as a wall-clock time). */
  timestamp: number;
  /** The taxonomy label for the indicator (a failed run is labeled by its failure kind). */
  label: DryRunOutcomeLabel;
}

/** The retained history + which entry is currently SELECTED (shown in the slot). */
export interface DryRunHistory {
  /** The entries, OLDEST first, newest last (capped at `DRY_RUN_HISTORY_CAP`). */
  entries: DryRunHistoryEntry[];
  /** The index of the currently selected entry, or -1 when the history is empty. */
  selected: number;
}

/** A fresh, empty history (no runs yet). */
export function emptyHistory(): DryRunHistory {
  return { entries: [], selected: -1 };
}

/** The taxonomy label for a completed dry-run message (its `kind` is the taxonomy). */
export function outcomeLabel(message: DryRunTraceMessage): DryRunOutcomeLabel {
  return message.kind;
}

/**
 * APPEND a completed dry-run and auto-select it (the latest). Enforces the cap by dropping
 * the OLDEST entries once the list would exceed `DRY_RUN_HISTORY_CAP`, keeping `selected`
 * pointed at the just-appended (now-last) entry. Returns a NEW history (pure — never mutates
 * the input), so the extension can swap state atomically.
 */
export function appendRun(history: DryRunHistory, entry: DryRunHistoryEntry): DryRunHistory {
  const grown = [...history.entries, entry];
  // Trim from the FRONT (oldest) so the newest `DRY_RUN_HISTORY_CAP` remain.
  const entries = grown.length > DRY_RUN_HISTORY_CAP ? grown.slice(grown.length - DRY_RUN_HISTORY_CAP) : grown;
  return { entries, selected: entries.length - 1 };
}

/**
 * SELECT an absolute index, clamped into range (a caller can't select past the ends). An
 * empty history stays at -1. Returns a NEW history with the same entries and the new
 * selection.
 */
export function selectRun(history: DryRunHistory, index: number): DryRunHistory {
  if (history.entries.length === 0) return { entries: history.entries, selected: -1 };
  const clamped = Math.max(0, Math.min(index, history.entries.length - 1));
  return { entries: history.entries, selected: clamped };
}

/** The direction of a ‹ › navigation: `prev` = one OLDER run, `next` = one NEWER run. */
export type NavDirection = "prev" | "next";

/**
 * NAVIGATE one step. `prev` moves toward OLDER runs (lower index), `next` toward NEWER
 * (higher index) — matching the ‹ › affordance where ‹ is older and › is newer. Clamped at
 * the ends (no wrap). An empty history is a no-op.
 */
export function navigate(history: DryRunHistory, direction: NavDirection): DryRunHistory {
  if (history.entries.length === 0) return history;
  const delta = direction === "prev" ? -1 : 1;
  return selectRun(history, history.selected + delta);
}

/** The currently selected entry, or undefined when the history is empty. */
export function selectedEntry(history: DryRunHistory): DryRunHistoryEntry | undefined {
  if (history.selected < 0 || history.selected >= history.entries.length) return undefined;
  return history.entries[history.selected];
}

/**
 * APPEND a completed dry-run WITHOUT moving the selection — the STALE-run arm (see
 * `recordCompletedRun`). The cap still trims from the front; the preserved selection shifts
 * down with the dropped entries (clamped at the new oldest if the selected entry itself fell
 * off). A history with NO selection (-1) keeps none: the slot is showing something newer (an
 * in-flight run's pending placeholder), and silently selecting the stale result would make
 * the focus-switch replay supersede it.
 */
export function appendRunPreservingSelection(history: DryRunHistory, entry: DryRunHistoryEntry): DryRunHistory {
  const grown = [...history.entries, entry];
  const dropped = Math.max(0, grown.length - DRY_RUN_HISTORY_CAP);
  const entries = dropped > 0 ? grown.slice(dropped) : grown;
  const selected = history.selected < 0 ? -1 : Math.max(0, history.selected - dropped);
  return { entries, selected };
}

/** The SELECTED run's live history view (index/total/timestamp/label), or undefined when none. */
export function historyView(history: DryRunHistory): DryRunHistoryView | undefined {
  const entry = selectedEntry(history);
  if (!entry) return undefined;
  return { index: history.selected, total: history.entries.length, timestamp: entry.timestamp, label: entry.label };
}

/**
 * The SELECTED run's message re-tagged with its LIVE history view, ready to post — derived
 * fresh each time so the `Run N of M` always reflects the current selection + total (the
 * stored entry deliberately carries no view; it would go stale as later runs shift the
 * count). Undefined when nothing is selected.
 */
export function tagSelected(history: DryRunHistory): DryRunTraceMessage | undefined {
  const entry = selectedEntry(history);
  const view = historyView(history);
  if (!entry || !view) return undefined;
  return { ...entry.message, history: view };
}

/** What recording one completed run produced: the new history + at most ONE display action. */
export interface RecordedRun {
  history: DryRunHistory;
  /** LATEST run: the auto-selected, tagged message to show in the dry-run slot. */
  show?: DryRunTraceMessage;
  /**
   * STALE run with a selected run on display: the truthful indicator refresh — the total
   * grew underneath the shown run, so its `Run N of M` must update WITHOUT replacing it.
   * Absent when nothing is selected (the slot shows a pending placeholder — no indicator).
   */
  indicatorUpdate?: DryRunHistoryView;
}

/**
 * Record ONE completed dry-run against the history — the pure seam behind the form
 * preview's dry-run `emit`. A completed result is appended ALWAYS, even when a newer stamp
 * made it stale for display (a second rapid submit, or a ‹ › navigation while it was in
 * flight): the user paid Backstage for that run, and dropping it would lose it
 * unrecoverably. `isLatest` gates only the DISPLAY action:
 *   - latest → append + auto-select; `show` carries the tagged message to post.
 *   - stale  → append PRESERVING the selection (the shown run stays shown);
 *              `indicatorUpdate` carries the refreshed count for the shown run (when one
 *              is selected), so the `Run N of M` indicator stays truthful.
 */
export function recordCompletedRun(
  history: DryRunHistory,
  message: DryRunTraceMessage,
  timestamp: number,
  isLatest: boolean,
): RecordedRun {
  const entry: DryRunHistoryEntry = {
    // Store the message WITHOUT a history view — the view is derived per-post (`tagSelected`),
    // so a stored one would go stale as later runs shift the total.
    message: { ...message, history: undefined },
    timestamp,
    label: outcomeLabel(message),
  };
  if (isLatest) {
    const next = appendRun(history, entry);
    return { history: next, show: tagSelected(next) };
  }
  const next = appendRunPreservingSelection(history, entry);
  return { history: next, indicatorUpdate: historyView(next) };
}
