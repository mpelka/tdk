// The TDK Trace view — a debugger-style master-detail panel that retains TWO SLOTS side
// by side, switched by a header segmented control (plain buttons with tab semantics — see
// the `tabs` style note for why not Fluent's <TabList>):
//
//   - LOCAL simulate  — the offline `execute()` trace, live as the form changes.
//   - Backstage dry-run — the last real dry-run against a live Backstage.
//
// Both slots PERSIST until replaced: a completed dry-run fills its slot and auto-switches
// the view to it, but the local trace is still one tab-click away, and vice versa. Each
// slot names its origin (the tab label, plus a header line) so the two engines are never
// confused. It lives in the PANEL area (a tab beside "Test Results"), draggable anywhere.
//
// ONE DETAIL, TWO ORIGINS. A dry-run's steps are NORMALIZED extension-side into the SAME
// `TraceStep[]` the local trace uses (`dryRunTrace.ts`) — provenance-paired, prettified
// expressions and all — so a SINGLE detail component renders both. A dry-run step also
// carries its ANSI-stripped run `log`, shown as an extra section; the dry-run slot adds a
// Files section and an endpoint header line on top.
//
// LAYOUT (master-detail, like a debugger's call stack + variables):
//   - a LEFT RAIL of the steps in execution order, each with a status glyph:
//       ran ✓ / skipped ⤼ / error ✗ / not reached ○.
//     `notReached` is a step that never ran because an earlier step ERRORED and halted the
//     run (real Backstage stops the task at the first failed step). It is selectable but
//     its detail is a single "never ran" line — no inputs/output. The first errored step
//     (else the first) is auto-selected on each new trace.
//   - a DETAIL pane for the selected step: Inputs with provenance (`expression → value`),
//     Output, Context, and — for a dry-run step — its grouped Log.
//
// GATING (local slot). An INVALID form (missing required fields) does NOT run `execute()`
// — it would only produce an error trace + downstream noise. The extension posts a
// `traceGated` instead: the slot shows a quiet "form incomplete — missing: …" placeholder,
// or, when a prior VALID trace exists, keeps showing it under a slim banner ("showing the
// last valid simulate"). A YAML source has no local simulate at all — the slot shows the
// same explanatory note the form panel does.
//
// LONG STRINGS. A string value that is multi-line OR long (> ~120 chars) is a code block,
// not a scalar: rendering it as JSON (`"…\n…\""`) turns a pretty-printed JSONata expression
// into escaped noise. So wherever a value renders — provenance leaves, output, context —
// such a string is shown VERBATIM in a monospace `<pre>` with REAL newlines and no JSON
// escaping, COLLAPSED BY DEFAULT behind a toggleable-section-header affordance.
//
// Deliberately QUIET (muted Fluent tokens, monospace values) so it reads like a developer
// tool, not a form.

import { Badge, makeStyles, shorthands, Text, tokens } from "@fluentui/react-components";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProvenanceNode } from "../lib/traceProvenance.ts";
import type {
  DryRunFile,
  DryRunLogLine,
  DryRunTraceMessage,
  ExtensionToTraceView,
  OpenDryRunFileMessage,
  TraceContext,
  TraceStep,
  TraceViewToExtension,
} from "./protocol.ts";

/**
 * A string is a BLOCK (render verbatim in a `<pre>`, not as inline JSON) when it spans
 * multiple lines or is long enough that the inline quoted form would wrap awkwardly.
 * The 120-char bound matches the compiler's own pretty-print width.
 */
const BLOCK_STRING_MAX_INLINE = 120;

/** Whether a value should render as a verbatim block (multi-line or long string). */
function isBlockString(value: unknown): value is string {
  return typeof value === "string" && (value.includes("\n") || value.length > BLOCK_STRING_MAX_INLINE);
}

/** The subtle size hint shown next to a block's key in its collapsed header. */
function blockSizeHint(text: string): string {
  const lines = text.split("\n");
  if (lines.length > 1) return `(${lines.length} lines)`;
  return `(${text.length} chars)`;
}

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  empty: { ...shorthands.padding("12px"), color: tokens.colorNeutralForeground3 },
  // The slot switcher — a segmented control naming the two origins. Plain Fluent-styled
  // buttons rather than Fluent's <TabList>/<Tab>, which crash under happy-dom (an event
  // handler fires during their render) and cannot be driven in the RTL tests; buttons are
  // both clickable there and read as the same segmented affordance.
  tabs: {
    display: "flex",
    ...shorthands.gap("2px"),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.padding("4px", "6px"),
    flexShrink: 0,
  },
  tab: {
    cursor: "pointer",
    ...shorthands.padding("2px", "10px"),
    ...shorthands.border("none"),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    backgroundColor: "transparent",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  tabActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  header: {
    ...shorthands.padding("6px", "10px"),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  // The dry-run slot's endpoint header line (baseUrl · status · duration).
  endpoint: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap("8px"),
    ...shorthands.padding("6px", "10px"),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground2,
    fontFamily: tokens.fontFamilyMonospace,
    color: tokens.colorNeutralForeground2,
  },
  endpointBadge: { flexShrink: 0 },
  // The run-history indicator + ‹ › nav (item #4): pushed to the right of the endpoint line.
  runNav: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap("4px"),
    marginLeft: "auto",
    flexShrink: 0,
  },
  runNavLabel: { color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  runNavButton: {
    cursor: "pointer",
    ...shorthands.border("none"),
    ...shorthands.padding("0", "6px"),
    backgroundColor: "transparent",
    color: tokens.colorBrandForeground2,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase300,
    ":disabled": { color: tokens.colorNeutralForeground4, cursor: "default" },
  },
  // The slim "form incomplete — showing the last valid simulate" banner over a stale trace.
  banner: {
    ...shorthands.padding("4px", "10px"),
    ...shorthands.borderBottom("1px", "solid", tokens.colorNeutralStroke2),
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  templateError: {
    ...shorthands.padding("10px"),
    color: tokens.colorPaletteRedForeground1,
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: "pre-wrap",
  },
  slotBody: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
  body: { display: "flex", flexGrow: 1, minHeight: 0 },
  // LEFT RAIL — the steps in execution order.
  rail: {
    flexShrink: 0,
    minWidth: "160px",
    maxWidth: "40%",
    overflowY: "auto",
    ...shorthands.borderRight("1px", "solid", tokens.colorNeutralStroke2),
  },
  railItem: {
    display: "flex",
    alignItems: "center",
    ...shorthands.gap("6px"),
    ...shorthands.padding("4px", "10px"),
    cursor: "pointer",
    ...shorthands.borderLeft("2px", "solid", "transparent"),
  },
  railItemActive: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  railGlyph: { fontFamily: tokens.fontFamilyMonospace, width: "12px", textAlign: "center" },
  railId: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  glyphRan: { color: tokens.colorPaletteGreenForeground1 },
  glyphSkipped: { color: tokens.colorNeutralForeground3 },
  glyphError: { color: tokens.colorPaletteRedForeground1 },
  glyphNotReached: { color: tokens.colorNeutralForeground4 },
  // DETAIL — the sections for the selected step.
  detail: { flexGrow: 1, overflowY: "auto", ...shorthands.padding("10px", "12px") },
  // A "not reached" step's one-line body — quiet, no sections.
  notReached: { color: tokens.colorNeutralForeground3, fontStyle: "italic" },
  // A "skipped" step's leading note — quiet, above the (expression-only) sections.
  skippedNote: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    ...shorthands.margin("0", "0", "10px", "0"),
  },
  section: { ...shorthands.margin("0", "0", "12px", "0") },
  sectionTitle: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightSemibold,
    ...shorthands.margin("0", "0", "4px", "0"),
    display: "block",
  },
  provRow: { ...shorthands.padding("2px", "0"), lineHeight: "1.5" },
  provKey: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  provExpr: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorBrandForeground2 },
  provArrow: { color: tokens.colorNeutralForeground3, ...shorthands.margin("0", "4px") },
  provValue: { fontFamily: tokens.fontFamilyMonospace, color: tokens.colorNeutralForeground2 },
  provNested: {
    ...shorthands.margin("0", "0", "0", "12px"),
    ...shorthands.borderLeft("1px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.padding("0", "0", "0", "8px"),
  },
  json: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre",
    overflowX: "auto",
    ...shorthands.margin("0"),
  },
  // A verbatim multi-line string block — real newlines, no JSON escaping.
  block: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre",
    overflowX: "auto",
    ...shorthands.margin("2px", "0", "0", "0"),
    ...shorthands.padding("4px", "8px"),
    backgroundColor: tokens.colorNeutralBackground2,
    ...shorthands.borderLeft("2px", "solid", tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusSmall),
  },
  blockHint: {
    color: tokens.colorNeutralForeground3,
    fontWeight: tokens.fontWeightRegular,
    ...shorthands.margin("0", "0", "0", "4px"),
  },
  errorText: {
    color: tokens.colorPaletteRedForeground1,
    fontFamily: tokens.fontFamilyMonospace,
    whiteSpace: "pre-wrap",
  },
  tree: { ...shorthands.margin("2px", "0", "0", "0") },
  treeSummary: { cursor: "pointer", color: tokens.colorNeutralForeground3 },
  // Dry-run LOG lines under a step.
  logLine: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    whiteSpace: "pre-wrap",
    color: tokens.colorNeutralForeground2,
    ...shorthands.padding("1px", "0"),
  },
  logFailed: { color: tokens.colorPaletteRedForeground1 },
  // Dry-run FILES.
  fileRow: { display: "flex", alignItems: "center", ...shorthands.gap("8px"), ...shorthands.padding("2px", "0") },
  fileLink: {
    cursor: "pointer",
    color: tokens.colorBrandForeground1,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    ...shorthands.textDecoration("none"),
    backgroundColor: "transparent",
    ...shorthands.border("none"),
    ...shorthands.padding("0"),
    textAlign: "left",
  },
  errorRow: { ...shorthands.padding("3px", "0"), lineHeight: "1.5" },
  errorWhere: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold },
  errorMessage: { color: tokens.colorNeutralForeground2, ...shorthands.margin("0", "0", "0", "6px") },
  authMessage: { color: tokens.colorPaletteRedForeground1 },
});

type Styles = ReturnType<typeof useStyles>;

/** Post back to the extension — the `ready` handshake and dry-run file clicks. */
export type TracePost = (msg: TraceViewToExtension) => void;

export interface TraceAppProps {
  /** The extension pushes trace results here; the app subscribes on mount. */
  subscribe: (handler: (msg: ExtensionToTraceView) => void) => void;
  /** Post back to the extension: the `ready` handshake and dry-run file-open clicks. */
  post: TracePost;
}

/** The LOCAL slot's retained state: empty, an ok trace, a template error, gated, or a YAML note. */
type LocalSlot =
  | { kind: "empty" }
  | { kind: "ok"; title?: string; steps: TraceStep[]; output: unknown }
  | { kind: "error"; title?: string; error: string }
  | { kind: "gated"; title?: string; missing: string[]; stale?: { steps: TraceStep[]; output: unknown } }
  | { kind: "yamlNote"; title?: string };

/** The DRY-RUN slot's retained state: empty, in flight, or a result. */
type DryRunSlot =
  | { kind: "empty" }
  | { kind: "pending"; title?: string; baseUrl?: string }
  | { kind: "result"; message: DryRunTraceMessage };

/** Which slot the switcher shows. */
type ActiveSlot = "local" | "dryRun";

/** Pick the step to auto-select on a new trace: the first errored one, else the first. */
function autoSelect(steps: TraceStep[]): number {
  const errored = steps.findIndex((s) => s.status === "error");
  return errored >= 0 ? errored : 0;
}

/**
 * The trace view. Owns the two retained slots, the active-slot switcher, and the selected
 * step index. Each slot updates independently (the extension's per-source seq guard keeps
 * a stale post from clobbering a fresher one), so switching tabs never loses either.
 */
export function TraceApp({ subscribe, post }: TraceAppProps): React.ReactElement {
  const styles = useStyles();
  const [local, setLocal] = useState<LocalSlot>({ kind: "empty" });
  const [dryRun, setDryRun] = useState<DryRunSlot>({ kind: "empty" });
  const [active, setActive] = useState<ActiveSlot>("local");
  // The two tab buttons, for the roving-focus arrow keys (see the tablist below).
  const localTabRef = useRef<HTMLButtonElement | null>(null);
  const dryRunTabRef = useRef<HTMLButtonElement | null>(null);

  // Subscribe, then post `ready` — the handshake. With the listener attached, the provider
  // can replay its buffered latest state without racing this async mount.
  useEffect(() => {
    subscribe((msg) => {
      switch (msg.type) {
        case "traceClear":
          setLocal({ kind: "empty" });
          setDryRun({ kind: "empty" });
          setActive("local");
          break;
        case "trace":
          if (msg.ok) setLocal({ kind: "ok", title: msg.title, steps: msg.steps ?? [], output: msg.output });
          else setLocal({ kind: "error", title: msg.title, error: msg.error ?? "The run failed." });
          break;
        case "traceGated":
          // The message is SELF-CONTAINED: the last valid trace (if any) rides in
          // `msg.stale`, so this render never depends on what the view showed before — a
          // gated message replayed on preview focus-switch (or a view re-create) lands
          // identically whether the slot was empty or held ANOTHER preview's trace.
          setLocal({ kind: "gated", title: msg.title, missing: msg.missing, stale: msg.stale });
          break;
        case "traceLocalUnavailable":
          setLocal({ kind: "yamlNote", title: msg.title });
          break;
        case "dryRunPending":
          setDryRun({ kind: "pending", title: msg.title, baseUrl: msg.baseUrl });
          // A dry-run is the active thing the user asked for — switch to it.
          setActive("dryRun");
          break;
        case "dryRunResult":
          setDryRun({ kind: "result", message: msg });
          setActive("dryRun");
          break;
        case "dryRunHistoryUpdate":
          // Refresh ONLY the indicator on a shown result — never switch tabs, never replace
          // the run. Sent when a STALE run's append grew the count under the shown run (see
          // the protocol note). With no result on display (empty/pending), there is no
          // indicator to refresh — ignore it.
          setDryRun((prev) =>
            prev.kind === "result" ? { kind: "result", message: { ...prev.message, history: msg.history } } : prev,
          );
          break;
      }
    });
    post({ type: "ready" });
  }, [subscribe, post]);

  // Both slots empty AND nothing ever posted → the first-open empty state.
  if (local.kind === "empty" && dryRun.kind === "empty") {
    return (
      <div className={styles.empty} data-testid="trace-empty">
        No trace yet. Open a form preview and edit its values to run execute() here.
      </div>
    );
  }

  // The ARIA tabs pattern: each tab names the ONE panel region (`aria-controls`), the
  // panel names its active tab back (`aria-labelledby`), and focus ROVES — only the
  // active tab is tabbable, arrow keys move selection + focus (two tabs, so either
  // arrow flips to the other).
  const onTablistKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: ActiveSlot = active === "local" ? "dryRun" : "local";
    setActive(next);
    (next === "local" ? localTabRef : dryRunTabRef).current?.focus();
  };

  return (
    <div className={styles.root}>
      <div className={styles.tabs} role="tablist" data-testid="trace-tabs" onKeyDown={onTablistKeyDown}>
        <button
          type="button"
          role="tab"
          id="trace-tab-local"
          aria-selected={active === "local"}
          aria-controls="trace-tabpanel"
          tabIndex={active === "local" ? 0 : -1}
          ref={localTabRef}
          data-testid="tab-local"
          className={`${styles.tab} ${active === "local" ? styles.tabActive : ""}`}
          onClick={() => setActive("local")}
        >
          Local simulate
        </button>
        <button
          type="button"
          role="tab"
          id="trace-tab-dryRun"
          aria-selected={active === "dryRun"}
          aria-controls="trace-tabpanel"
          tabIndex={active === "dryRun" ? 0 : -1}
          ref={dryRunTabRef}
          data-testid="tab-dryRun"
          className={`${styles.tab} ${active === "dryRun" ? styles.tabActive : ""}`}
          onClick={() => setActive("dryRun")}
        >
          Backstage dry-run
        </button>
      </div>
      <div
        role="tabpanel"
        id="trace-tabpanel"
        aria-labelledby={active === "local" ? "trace-tab-local" : "trace-tab-dryRun"}
        className={styles.slotBody}
        data-testid="trace-tabpanel"
      >
        {active === "local" ? (
          <LocalPanel slot={local} styles={styles} />
        ) : (
          <DryRunPanel slot={dryRun} styles={styles} post={post} />
        )}
      </div>
    </div>
  );
}

// --- The LOCAL slot -----------------------------------------------------------

/** The local-simulate slot: an ok trace, a template error, a gating placeholder, or the YAML note. */
function LocalPanel({ slot, styles }: { slot: LocalSlot; styles: Styles }): React.ReactElement {
  if (slot.kind === "empty") {
    return (
      <div className={styles.empty} data-testid="local-empty">
        No local simulate yet. Edit the form to run execute() here.
      </div>
    );
  }
  if (slot.kind === "yamlNote") {
    // The same wording the form panel uses for a YAML source.
    return (
      <div className={styles.slotBody} data-testid="local-yaml-note">
        {slot.title && <div className={styles.header}>{slot.title}</div>}
        <div className={styles.empty}>
          TDK features — scenarios, local trace, and env — available for template.ts sources.
        </div>
      </div>
    );
  }
  if (slot.kind === "error") {
    return (
      <div className={styles.slotBody}>
        {slot.title && <div className={styles.header}>{slot.title}</div>}
        <div className={styles.templateError} data-testid="trace-template-error">
          {slot.error}
        </div>
      </div>
    );
  }
  if (slot.kind === "gated") {
    return <GatedPanel slot={slot} styles={styles} />;
  }
  return <StepsPanel title={slot.title} steps={slot.steps} output={slot.output} styles={styles} />;
}

/**
 * The gating state. With NO prior valid trace: a quiet placeholder listing the missing
 * fields. With one (`stale`): the last valid trace shown UNDER a slim banner, so a mid-edit
 * user keeps their last good simulate on screen instead of a blank.
 */
function GatedPanel({
  slot,
  styles,
}: {
  slot: Extract<LocalSlot, { kind: "gated" }>;
  styles: Styles;
}): React.ReactElement {
  const missing = slot.missing.length > 0 ? slot.missing.join(", ") : "required fields";
  if (slot.stale) {
    return (
      <div className={styles.slotBody} data-testid="local-gated-stale">
        <div className={styles.banner} data-testid="gated-banner">
          Form incomplete — missing: {missing}. Showing the last valid simulate.
        </div>
        <StepsPanel title={slot.title} steps={slot.stale.steps} output={slot.stale.output} styles={styles} />
      </div>
    );
  }
  return (
    <div className={styles.slotBody} data-testid="local-gated">
      {slot.title && <div className={styles.header}>{slot.title}</div>}
      <div className={styles.empty} data-testid="gated-placeholder">
        Form incomplete — missing: {missing}
      </div>
    </div>
  );
}

// --- The DRY-RUN slot ---------------------------------------------------------

/** The dry-run slot: empty, in flight, or a classified result. */
function DryRunPanel({
  slot,
  styles,
  post,
}: {
  slot: DryRunSlot;
  styles: Styles;
  post: TracePost;
}): React.ReactElement {
  if (slot.kind === "empty") {
    return (
      <div className={styles.empty} data-testid="dryrun-empty">
        No dry-run yet — use Dry-run in Backstage in the form preview.
      </div>
    );
  }
  if (slot.kind === "pending") {
    return (
      <div className={styles.slotBody} data-testid="dryrun-pending">
        {slot.baseUrl && (
          <div className={styles.endpoint} data-testid="dryrun-endpoint">
            <Badge className={styles.endpointBadge} appearance="tint" color="brand" size="small">
              Backstage dry-run
            </Badge>
            <span>{slot.baseUrl}</span>
          </div>
        )}
        <div className={styles.empty}>Running dry-run in Backstage…</div>
      </div>
    );
  }
  return <DryRunResultView message={slot.message} styles={styles} post={post} />;
}

/** A completed dry-run: the endpoint header + the state-specific body. */
function DryRunResultView({
  message,
  styles,
  post,
}: {
  message: DryRunTraceMessage;
  styles: Styles;
  post: TracePost;
}): React.ReactElement {
  return (
    <div className={styles.slotBody} data-testid="dryrun-view">
      <EndpointHeader message={message} styles={styles} post={post} />
      <DryRunBody message={message} styles={styles} post={post} />
    </div>
  );
}

/**
 * The `Backstage dry-run · <baseUrl> · <status> · <duration>` header line, plus — when the
 * extension tracks run HISTORY (item #4) — a `Run N of M · <time>` indicator with ‹ ›
 * navigation. The ‹ › buttons post `dryRunNavigate`; the extension moves its per-preview
 * history and replays the selected run (a nav is NOT view-local state — the extension owns
 * the history so it survives tab flips). ‹ is disabled at the oldest run, › at the newest.
 */
function EndpointHeader({
  message,
  styles,
  post,
}: {
  message: DryRunTraceMessage;
  styles: Styles;
  post: TracePost;
}): React.ReactElement {
  const { baseUrl, status, durationMs } = message.endpoint;
  const history = message.history;
  return (
    <div className={styles.endpoint} data-testid="dryrun-endpoint">
      <Badge className={styles.endpointBadge} appearance="tint" color="brand" size="small">
        Backstage dry-run
      </Badge>
      <span>
        {baseUrl} · {status} · {durationMs}ms
      </span>
      {message.title && <span>· {message.title}</span>}
      {history && <RunIndicator history={history} styles={styles} post={post} />}
    </div>
  );
}

/**
 * The run-history indicator: `Run N of M · HH:MM:SS` (+ a taxonomy tag for a failed run),
 * flanked by ‹ (older) and › (newer) buttons. Plain buttons — Fluent's TabList/Menu crash
 * under happy-dom (the established idiom in this view); the buttons keep sane ARIA labels.
 */
function RunIndicator({
  history,
  styles,
  post,
}: {
  history: NonNullable<DryRunTraceMessage["history"]>;
  styles: Styles;
  post: TracePost;
}): React.ReactElement {
  const atOldest = history.index <= 0;
  const atNewest = history.index >= history.total - 1;
  return (
    <span className={styles.runNav} data-testid="dryrun-run-indicator">
      <button
        type="button"
        className={styles.runNavButton}
        aria-label="Previous (older) dry-run"
        data-testid="dryrun-run-prev"
        disabled={atOldest}
        onClick={() => post({ type: "dryRunNavigate", direction: "prev" })}
      >
        ‹
      </button>
      <span className={styles.runNavLabel} data-testid="dryrun-run-label">
        Run {history.index + 1} of {history.total} · {formatRunTime(history.timestamp)}
        {history.label !== "ok" && ` · ${runLabelText(history.label)}`}
      </span>
      <button
        type="button"
        className={styles.runNavButton}
        aria-label="Next (newer) dry-run"
        data-testid="dryrun-run-next"
        disabled={atNewest}
        onClick={() => post({ type: "dryRunNavigate", direction: "next" })}
      >
        ›
      </button>
    </span>
  );
}

/** A human wall-clock `HH:MM:SS` for a run's completion timestamp (local time). */
function formatRunTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The taxonomy label text shown for a FAILED run in the indicator. */
function runLabelText(label: NonNullable<DryRunTraceMessage["history"]>["label"]): string {
  if (label === "validationFailed") return "validation failed";
  if (label === "authFailed") return "auth failed";
  return "error";
}

/** The dry-run body: the master-detail (ok) or one of the three failure states. */
function DryRunBody({
  message,
  styles,
  post,
}: {
  message: DryRunTraceMessage;
  styles: Styles;
  post: TracePost;
}): React.ReactElement {
  if (message.kind === "authFailed") {
    return (
      <div className={`${styles.templateError} ${styles.authMessage}`} data-testid="dryrun-auth-error">
        {message.message}
      </div>
    );
  }
  if (message.kind === "error") {
    return (
      <div className={styles.templateError} data-testid="dryrun-error">
        {message.message}
      </div>
    );
  }
  if (message.kind === "validationFailed") {
    return <ValidationErrors errors={message.errors ?? []} styles={styles} />;
  }
  return (
    <StepsPanel
      title={undefined}
      steps={message.steps ?? []}
      output={message.output}
      styles={styles}
      preamble={message.preamble ?? []}
      files={message.files ?? []}
      post={post}
    />
  );
}

/** The 400 validation-error list — `where — message`, the free server-side validation. */
function ValidationErrors({
  errors,
  styles,
}: {
  errors: { where: string; message: string }[];
  styles: Styles;
}): React.ReactElement {
  return (
    <div className={styles.detail} data-testid="dryrun-validation">
      <Text className={styles.sectionTitle}>Backstage rejected the values (server-side validation)</Text>
      {errors.length === 0 ? (
        <div className={styles.empty}>No specific errors were returned.</div>
      ) : (
        errors.map((e) => (
          <div className={styles.errorRow} key={`${e.where}:${e.message}`} data-testid={`dryrun-error-${e.where}`}>
            <span className={styles.errorWhere}>{e.where}</span>
            <span className={styles.errorMessage}>{e.message}</span>
          </div>
        ))
      )}
    </div>
  );
}

// --- The shared step master-detail (BOTH origins) -----------------------------

/**
 * The step rail + detail, shared by the local trace and the dry-run. Optional `preamble`,
 * `files`, and `post` are dry-run-only (the local trace passes none). Owns the selected
 * step index, re-auto-selecting on each new `steps` array.
 */
function StepsPanel({
  title,
  steps,
  output,
  styles,
  preamble,
  files,
  post,
}: {
  title?: string;
  steps: TraceStep[];
  output: unknown;
  styles: Styles;
  preamble?: DryRunLogLine[];
  files?: DryRunFile[];
  post?: TracePost;
}): React.ReactElement {
  const [selected, setSelected] = useState(0);
  // Re-select the first-errored (else first) step whenever a NEW result arrives (the
  // `steps` array identity changes).
  useEffect(() => setSelected(autoSelect(steps)), [steps]);

  const current = steps[Math.min(selected, Math.max(0, steps.length - 1))];
  return (
    <div className={styles.slotBody}>
      {title && <div className={styles.header}>{title}</div>}
      {preamble && preamble.length > 0 && (
        <div className={styles.header} data-testid="dryrun-preamble">
          {preamble.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: preamble lines are static per result and may repeat
            <div key={i}>{l.message}</div>
          ))}
        </div>
      )}
      {steps.length === 0 ? (
        <div className={styles.empty} data-testid="trace-no-steps">
          No steps ran. The run produced output {jsonText(output)}.
        </div>
      ) : (
        <div className={styles.body}>
          <Rail steps={steps} selected={selected} onSelect={setSelected} styles={styles} />
          {current && <Detail step={current} styles={styles} files={files} post={post} />}
        </div>
      )}
    </div>
  );
}

/** The left rail: one selectable row per step, with its status glyph. */
function Rail({
  steps,
  selected,
  onSelect,
  styles,
}: {
  steps: TraceStep[];
  selected: number;
  onSelect: (i: number) => void;
  styles: Styles;
}): React.ReactElement {
  return (
    <div className={styles.rail} data-testid="trace-rail" role="listbox" aria-label="Trace steps">
      {steps.map((s, i) => (
        <div
          key={s.id}
          role="option"
          aria-selected={i === selected}
          data-testid={`trace-rail-${s.id}`}
          className={`${styles.railItem} ${i === selected ? styles.railItemActive : ""}`}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onSelect(i);
          }}
          tabIndex={0}
        >
          <span className={`${styles.railGlyph} ${glyphClass(s.status, styles)}`}>{glyph(s.status)}</span>
          <span className={styles.railId}>{s.id}</span>
        </div>
      ))}
    </div>
  );
}

/** The status glyph for the rail: ran ✓ / skipped ⤼ / error ✗ / not reached ○. */
function glyph(status: TraceStep["status"]): string {
  if (status === "error") return "✗";
  if (status === "skipped") return "⤼";
  if (status === "notReached") return "○";
  return "✓";
}

/** The Fluent color class for a status glyph. */
function glyphClass(status: TraceStep["status"], styles: Styles): string {
  if (status === "error") return styles.glyphError;
  if (status === "skipped") return styles.glyphSkipped;
  if (status === "notReached") return styles.glyphNotReached;
  return styles.glyphRan;
}

/**
 * The detail pane for the selected step. A `notReached` step gets a single "never ran"
 * line — no sections. A `skipped` step leads with a "skipped — its `if:` was false" note,
 * THEN its sections (Inputs render expression-only — the step never ran, so nothing
 * resolved). Otherwise: Inputs+provenance, Output, Context, and (dry-run only) the step's
 * Log; a dry-run's emitted Files render once at the bottom of the pane.
 */
function Detail({
  step,
  styles,
  files,
  post,
}: {
  step: TraceStep;
  styles: Styles;
  files?: DryRunFile[];
  post?: TracePost;
}): React.ReactElement {
  if (step.status === "notReached") {
    return (
      <div className={styles.detail} data-testid="trace-detail">
        <div className={styles.notReached} data-testid="trace-not-reached">
          This step never ran: the run halted at the first failed step.
        </div>
      </div>
    );
  }
  return (
    <div className={styles.detail} data-testid="trace-detail">
      {/* A skipped step's note — mirrors the LOCAL presentation and explains the ⤼ glyph.
          Its Inputs below render expression-only (the `if:` was false, so nothing ran). The
          scaffolder's real "Skipping step …" line rides in the Log section for a dry-run. */}
      {step.status === "skipped" && (
        <div className={styles.skippedNote} data-testid="trace-skipped">
          This step was skipped: its <code>if:</code> condition was false, so it never ran.
        </div>
      )}
      <section className={styles.section} data-testid="trace-inputs">
        <Text className={styles.sectionTitle}>Inputs</Text>
        {step.provenance.length === 0 ? (
          <div className={styles.provValue}>(no inputs)</div>
        ) : (
          step.provenance.map((node) => <ProvRow key={node.key} node={node} styles={styles} />)
        )}
      </section>

      {/* Output — a local step always has one; a dry-run step reports none (Backstage
          returns only the run's final output), so we omit the section for it. */}
      {step.status === "error" ? (
        <section className={styles.section} data-testid="trace-output">
          <Text className={styles.sectionTitle}>Output</Text>
          <div className={styles.errorText} data-testid="trace-step-error">
            {step.error}
          </div>
        </section>
      ) : step.output !== undefined ? (
        <section className={styles.section} data-testid="trace-output">
          <Text className={styles.sectionTitle}>Output</Text>
          <JsonTree label="output" value={step.output} open styles={styles} />
        </section>
      ) : null}

      <section className={styles.section} data-testid="trace-context">
        <Text className={styles.sectionTitle}>Context at this step</Text>
        <ContextTree context={step.context} styles={styles} />
      </section>

      {step.log && step.log.length > 0 && (
        <section className={styles.section} data-testid={`dryrun-log-${step.id}`}>
          <Text className={styles.sectionTitle}>Log</Text>
          {step.log.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: log lines are static per result and may repeat verbatim
              key={i}
              className={`${styles.logLine} ${l.status === "failed" ? styles.logFailed : ""}`}
            >
              {l.message}
            </div>
          ))}
        </section>
      )}

      {files !== undefined && <FilesSection files={files} styles={styles} post={post} />}
    </div>
  );
}

/**
 * One provenance row. A LEAF shows one of three forms:
 *   - `key: expression → value` when TEMPLATED (a `${{ … }}` source that resolved),
 *   - `key: expression` — EXPRESSION-ONLY — when the source is an expression but NO value
 *     was recovered (a step that never ran: skipped by an `if:`, or otherwise not resolved).
 *     NEVER `key: undefined` — that would be a manufactured value the "never guess" contract
 *     forbids, and it silently dropped the expression (the exact bug this fixes),
 *   - `key: value` when a plain LITERAL (no source expression).
 * A BRANCH (object/array) shows its key and nests its children indented. A leaf whose
 * RESOLVED value is a multi-line/long string renders behind a collapsed toggleable section.
 */
function ProvRow({ node, styles }: { node: ProvenanceNode; styles: Styles }): React.ReactElement {
  if (node.kind === "object" || node.kind === "array") {
    return (
      <div className={styles.provRow} data-testid={`prov-${node.key}`}>
        <span className={styles.provKey}>{node.key}</span>
        <span className={styles.provArrow}>{node.kind === "array" ? "[…]" : "{…}"}</span>
        <div className={styles.provNested}>
          {(node.children ?? []).map((child) => (
            <ProvRow key={child.key} node={child} styles={styles} />
          ))}
        </div>
      </div>
    );
  }
  const templated = node.templated && node.expression !== undefined;
  // EXPRESSION-ONLY: an expression is present but nothing resolved (value undefined and not
  // templated). Show the expression alone — no `→`, no fabricated `undefined`. This is the
  // fidelity fix for a step that never ran (a skipped `if:`, a not-reached step, or a
  // parse-failure fallback): its inputs render their SOURCE, never a guessed value.
  const expressionOnly = !templated && node.expression !== undefined && node.value === undefined;
  const block = isBlockString(node.value);
  // A block leaf collapses its whole row behind the key as the toggle header.
  if (block) {
    return (
      <CollapsibleBlock
        label={node.key}
        text={node.value as string}
        prefix={
          templated ? (
            <>
              <span className={styles.provArrow}>:</span>
              <span className={styles.provExpr} data-testid={`prov-expr-${node.key}`}>
                {node.expression}
              </span>
              <span className={styles.provArrow}>→</span>
            </>
          ) : (
            <span className={styles.provArrow}>:</span>
          )
        }
        styles={styles}
        rowTestid={`prov-${node.key}`}
        testid={`prov-block-${node.key}`}
      />
    );
  }
  // A scalar leaf: the arrow (→ value) only when templated; the source expression ALONE when
  // expression-only; otherwise the bare literal value.
  return (
    <div className={styles.provRow} data-testid={`prov-${node.key}`}>
      <span className={styles.provKey}>{node.key}</span>
      <span className={styles.provArrow}>:</span>
      {templated ? (
        <>
          <span className={styles.provExpr} data-testid={`prov-expr-${node.key}`}>
            {node.expression}
          </span>
          <span className={styles.provArrow}>→</span>
          <span className={styles.provValue}>{jsonText(node.value)}</span>
        </>
      ) : expressionOnly ? (
        <span className={styles.provExpr} data-testid={`prov-expr-${node.key}`}>
          {node.expression}
        </span>
      ) : (
        <span className={styles.provValue} data-testid={`prov-literal-${node.key}`}>
          {jsonText(node.value)}
        </span>
      )}
    </div>
  );
}

/** The "Context at this step" collapsible tree — `parameters` only, collapsed by default. */
function ContextTree({ context, styles }: { context: TraceContext; styles: Styles }): React.ReactElement {
  return (
    <div>
      <JsonTree label="parameters" value={context.parameters} styles={styles} />
    </div>
  );
}

/**
 * The emitted-files section (dry-run only): each path is a button that posts
 * `openDryRunFile` (the extension opens it as a read-only virtual document). An exec bit
 * shows as a badge; an empty list is a quiet "no files emitted" note.
 */
function FilesSection({
  files,
  styles,
  post,
}: {
  files: DryRunFile[];
  styles: Styles;
  post?: TracePost;
}): React.ReactElement {
  return (
    <section className={styles.section} data-testid="dryrun-files">
      <Text className={styles.sectionTitle}>Files</Text>
      {files.length === 0 ? (
        <div className={styles.empty} data-testid="dryrun-no-files">
          No files emitted.
        </div>
      ) : (
        files.map((f) => (
          <div className={styles.fileRow} key={f.path} data-testid={`dryrun-file-${f.path}`}>
            <button
              type="button"
              className={styles.fileLink}
              onClick={() =>
                post?.({ type: "openDryRunFile", path: f.path, content: f.content } satisfies OpenDryRunFileMessage)
              }
            >
              {f.path}
            </button>
            {f.executable && (
              <Badge appearance="outline" color="warning" size="small" data-testid={`dryrun-file-exec-${f.path}`}>
                executable
              </Badge>
            )}
          </div>
        ))
      )}
    </section>
  );
}

/**
 * A collapsible block: a `<details>` whose summary is the label. A multi-line/long STRING
 * renders behind the SAME collapsed-by-default toggle everywhere; otherwise it pretty-prints
 * the value as JSON. `open` controls the initial expansion for the JSON case (output open,
 * context collapsed) — a block string is ALWAYS collapsed by default.
 */
function JsonTree({
  label,
  value,
  open = false,
  styles,
}: {
  label: string;
  value: unknown;
  open?: boolean;
  styles: Styles;
}): React.ReactElement {
  const block = isBlockString(value);
  const json = useMemo(() => (block ? "" : jsonText(value)), [value, block]);
  if (block) {
    return <CollapsibleBlock label={label} text={value as string} styles={styles} testid={`block-${label}`} />;
  }
  return (
    <details className={styles.tree} open={open}>
      <summary className={styles.treeSummary}>{label}</summary>
      <pre className={styles.json}>{json}</pre>
    </details>
  );
}

/**
 * A block string's collapse affordance — a `<details>`/`<summary>` pair, COLLAPSED BY
 * DEFAULT. The summary is the key plus a size hint (e.g. "(14 lines)"), with an optional
 * `prefix` (a provenance leaf's `:` or `expression →`) rendered before it. Expanding reveals
 * the full verbatim block — real newlines, no JSON escaping. The content mounts only while
 * open, so a collapsed block is genuinely absent from the DOM.
 */
function CollapsibleBlock({
  label,
  text,
  prefix,
  styles,
  rowTestid,
  testid,
}: {
  label: string;
  text: string;
  prefix?: React.ReactNode;
  styles: Styles;
  rowTestid?: string;
  testid: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hint = useMemo(() => blockSizeHint(text), [text]);
  return (
    <details
      className={styles.tree}
      data-testid={rowTestid}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className={styles.treeSummary}>
        <span className={styles.provKey}>{label}</span>
        {prefix}
        <span className={styles.blockHint}>{hint}</span>
      </summary>
      {open && (
        <pre className={styles.block} data-testid={testid}>
          {text}
        </pre>
      )}
    </details>
  );
}

/** Pretty-print a value as JSON; `undefined` shows as the literal `undefined`. */
function jsonText(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value, null, 2);
}
