// The message protocol between the extension host and the two webviews — the
// form-preview PANEL and the TDK Trace VIEW. Both sides import these types — the
// single source of truth for what crosses the `postMessage` boundary, so a change to
// a message shape is a type error on both ends. Keep it a plain type module (no
// `vscode`, no React imports) so either runtime can pull it in.

import type { ProvenanceNode } from "../lib/traceProvenance.ts";

/** A JSON Schema object, loosely typed — we walk it structurally, never validate it here. */
export type JsonSchema = Record<string, unknown>;

/** An RJSF uiSchema object, mirroring a schema's shape (`ui:*` keys pulled out of it). */
export type UiSchema = Record<string, unknown>;

/**
 * One page of the form, already split for RJSF: the pure JSON Schema (no `ui:*`
 * keys) and the mirrored uiSchema. `title` is the page's heading (the stepper
 * step label), if the compiled page carried one.
 */
export interface FormPage {
  title?: string;
  schema: JsonSchema;
  uiSchema: UiSchema;
}

// --- Form panel: extension → webview -----------------------------------------

/**
 * Where a previewed template came from — the DISCRIMINANT the webview uses to decide
 * which controls are meaningful:
 *   - `tdk`  — a `.ts` template compiled through the CLI. The env selector, the scenario
 *     picker, save-as-scenario, and the LOCAL execute trace all apply.
 *   - `yaml` — a plain YAML Scaffolder template; the buffer IS the artifact (no compile).
 *     The env is fixed, and scenarios / local trace are TDK-only, so the webview HIDES
 *     those controls and shows a one-line note that they need a `template.ts` source.
 * Dry-run works for both. Older messages without a `source` are treated as `tdk`.
 */
export type TemplateSource = "tdk" | "yaml";

/**
 * Extension -> form webview: a fresh compile succeeded (or, for a YAML source, the
 * buffer parsed). Carries every page (already split), the template's identity + title
 * for the header, and the env it was compiled for (so the minimal header reflects the
 * active env). The env and scenario are picked through NATIVE QuickPicks (see
 * `PickEnvMessage` / `PickScenarioMessage`); the webview only DISPLAYS them in a
 * one-line header. `source` tells the webview which controls to show: a `yaml` source
 * hides the TDK-only env/scenario/save affordances (see `TemplateSource`).
 */
export interface TemplateMessage {
  type: "template";
  /** Stable id for this preview — the template file's path. */
  templateId: string;
  /** The template's display title (from `metadata.title`), for the panel header. */
  title: string;
  /** The env this was compiled for (shown in the header; ignored for a `yaml` source). */
  env: string;
  /** Where this preview came from — `tdk` (compiled `.ts`) or `yaml` (plain YAML buffer).
   *  Optional for back-compat; absent means `tdk`. */
  source?: TemplateSource;
  pages: FormPage[];
}

/**
 * Extension -> form webview: the latest compile FAILED. The webview shows this as a
 * dismissable banner and keeps the last good form rendered underneath — a
 * transient error never blanks the preview (mirrors the compile-preview panel).
 * `message` is the CLI's `file:line:col: message` text.
 */
export interface CompileErrorMessage {
  type: "compileError";
  message: string;
}

/**
 * One scenario the form can PREFILL from — its display name and the fixture
 * `parameters` those prefill values come from. `hasStepMocks` tells the picker
 * whether selecting it also arms the trace with mocked step outputs (the extension
 * remembers the mocks itself; the webview only needs the flag for a hint).
 */
export interface ScenarioSummary {
  name: string;
  branches?: string[];
  parameters?: Record<string, unknown>;
  hasStepMocks: boolean;
}

/**
 * Extension -> form webview: the list of scenarios discovered in the template's
 * sibling `__fixtures__/scenarios.ts`. The webview keeps these only so the header
 * can reflect how many scenarios exist and whether the scenario affordance is
 * meaningful; SELECTING one now happens through a native QuickPick, not a Fluent
 * dropdown.
 */
export interface ScenariosMessage {
  type: "scenarios";
  scenarios: ScenarioSummary[];
}

/**
 * Extension -> form webview: prefill the form with a scenario's parameter values
 * (merged into the current values, then reset to page 1). Sent when the user picks a
 * scenario in the native QuickPick OR opens the preview from a Test Explorer scenario
 * item. `name` echoes which scenario, so the header can reflect the selection.
 */
export interface ScenarioPrefillMessage {
  type: "scenarioPrefill";
  name: string;
  values: Record<string, unknown>;
}

/**
 * Extension -> form webview: whether Backstage dry-run is CONFIGURED (item #5). The Review
 * step's "Dry-run in Backstage" button is DISABLED with a visible hint until
 * `tdk.backstage.baseUrl` is set — a click that only prompts is a dead end. The extension
 * posts this with the panel's initial state AND on `workspace.onDidChangeConfiguration`, so
 * setting the base URL LIVE re-enables the button with no reload.
 *
 * `configured` is solely whether the base URL is set — a MISSING TOKEN does NOT disable the
 * button (some backends accept anonymous requests; the authFailed taxonomy already guides a
 * rejected token). The hint (rendered view-side) still mentions both the set-base-URL and
 * set-token commands. Absent/older messages are treated as configured (back-compat).
 */
export interface DryRunCapabilityMessage {
  type: "dryRunCapability";
  /** True when `tdk.backstage.baseUrl` is set (the button is enabled); false disables it. */
  configured: boolean;
}

/** Every message the extension can post to the FORM webview. */
export type ExtensionToWebview =
  | TemplateMessage
  | CompileErrorMessage
  | ScenariosMessage
  | ScenarioPrefillMessage
  | DryRunCapabilityMessage;

// --- Form panel: webview → extension -----------------------------------------

/**
 * Form webview -> extension: the React app has mounted AND subscribed to messages.
 * Posted ONCE, immediately after the message listener attaches — the READY handshake.
 * The extension buffers the panel's initial state (the last `template`, `scenarios`,
 * and any scenario prefill) and (re)plays it when this arrives, so the very first
 * `template` message can never be lost to the mount/subscribe race: the listener
 * attaches in a useEffect AFTER the async mount, so an eager pre-mount post is dropped
 * outright. Later updates still post eagerly — `ready` gates only the initial replay.
 */
export interface ReadyMessage {
  type: "ready";
}

/**
 * Form webview -> extension: the user edited the form. The extension debounces these
 * and runs one `execute()` with the current values, posting the result to the TDK
 * Trace VIEW (not back to this panel).
 *
 * VALIDITY-GATING. The webview also reports whether the current values satisfy the FULL
 * set of page schemas' `required` lists (`valid`) and, when not, which fields are missing
 * (`missing`, by schema `title` falling back to the property name — computed by the pure
 * `formValidity` seam the webview already has the schemas for). The extension runs a local
 * `execute()` only when `valid` — an empty/partial form would otherwise yield an error
 * trace plus downstream noise. When invalid it posts a `traceGated` instead (see there).
 * These fields are absent for a `yaml` source (no local simulate) and treated as valid by
 * older messages that omit them.
 */
export interface ValuesChangedMessage {
  type: "valuesChanged";
  values: unknown;
  /** Whether the values satisfy every page schema's required list (omitted = treat as valid). */
  valid?: boolean;
  /** When invalid: the missing required fields, by schema `title` (fallback: property name). */
  missing?: string[];
}

/**
 * Form webview -> extension: the user clicked the env text in the header. The
 * extension opens the SAME native env QuickPick the `tdk.formPreview.pickEnv` palette
 * command opens — the click is just a discoverable in-panel affordance for it.
 * Carrying nothing keeps the extension the single source of truth for the env list +
 * current value.
 */
export interface PickEnvMessage {
  type: "pickEnv";
}

/**
 * Form webview -> extension: the user clicked the scenario text in the header. The
 * extension opens the SAME native scenario QuickPick the `tdk.formPreview.pickScenario`
 * palette command opens.
 */
export interface PickScenarioMessage {
  type: "pickScenario";
}

/**
 * Form webview -> extension: capture the current form values as a NEW scenario. The
 * extension prompts for a name and inserts an entry into the template's
 * `__fixtures__/scenarios.ts` — the reverse arrow that turns manual form-filling
 * into a committed fixture.
 */
export interface SaveScenarioMessage {
  type: "saveScenario";
  values: Record<string, unknown>;
}

/**
 * Form webview -> extension: the user clicked "Dry-run in Backstage" on the Review step.
 * The extension compiles the CURRENT env's template, POSTs it to Backstage's dry-run
 * endpoint with these `values`, and renders the classified outcome in the TDK Trace view
 * (as a distinct Backstage-origin result). Carrying the values keeps the webview the
 * source of truth for what the form would submit.
 */
export interface DryRunSubmitMessage {
  type: "dryRunSubmit";
  values: Record<string, unknown>;
}

/** Every message the FORM webview can post to the extension. */
export type WebviewToExtension =
  | ReadyMessage
  | ValuesChangedMessage
  | PickEnvMessage
  | PickScenarioMessage
  | SaveScenarioMessage
  | DryRunSubmitMessage;

// --- TDK Trace view: the debugger-style master-detail panel ------------------

/**
 * One step of a live trace, enriched for the trace VIEW. Beyond the raw resolved
 * `input`/`output`/`error`, it carries:
 *   - `provenance`: the per-input-key pairing of the compiled `${{ … }}` source with
 *     the resolved value (built extension-side by `pairStepInputs`), for the "Inputs
 *     with provenance" section.
 *   - `context`: what `${{ }}` could see AT this step — the run's `parameters`, for the
 *     collapsible "Context at this step" tree. Prior steps' outputs are NOT carried
 *     here: the rail already lets you select an earlier step to read its output, so
 *     duplicating them in every step's context was redundant.
 * `status` collapses the raw flags into the rail's glyph: ran ✓ / skipped ⤼ / error ✗ /
 * not reached ○. `notReached` is a step that never ran because an EARLIER step errored
 * and HALTED the run — real Backstage stops the task at the first failed step, and
 * `execute()` mirrors that. Such a step has no meaningful input/output: it renders a
 * single "never ran" line, no Inputs/Output/Context sections.
 *
 * A dry-run step reuses the SAME shape (normalized by `dryRunTrace.ts`): its `provenance`
 * pairs the compiled source against the values Backstage reported, so BOTH origins render
 * through one detail component. A dry-run step additionally carries `log` (the grouped,
 * ANSI-stripped run log for that step) — a local execute has none, so it leaves it unset.
 */
export interface TraceStep {
  id: string;
  /** The step's rail status: ran / skipped by an `if:` / errored / not reached (halt). */
  status: "ran" | "skipped" | "error" | "notReached";
  input: unknown;
  output: unknown;
  error?: string;
  /** Per-input-key provenance rows: compiled source expression paired with resolved value. */
  provenance: ProvenanceNode[];
  /** The `${{ }}` context visible at this step: the run's parameters. */
  context: TraceContext;
  /**
   * DRY-RUN only: the step's grouped, ANSI-stripped run-log lines (Backstage reports a
   * run log; a local execute has none). Rendered as an extra "Log" section in the detail.
   */
  log?: DryRunLogLine[];
}

/** The `${{ }}` context a step could see: the run's parameters. */
export interface TraceContext {
  parameters: unknown;
}

/**
 * Extension -> trace view: the result of running the current form values through
 * `execute()`. `ok:false` carries a template-level `error` (a compile/run failure)
 * shown as a single line; `ok:true` carries the per-step `steps` (each with its
 * provenance + context) and the final `output`. `title` names the template in the
 * view's header so the trace and the form panel visibly refer to the same template.
 *
 * This message always fills the LOCAL slot (the trace view retains a local slot and a
 * dry-run slot side by side — see `ExtensionToTraceView`).
 */
export interface TraceMessage {
  type: "trace";
  ok: boolean;
  /** The template whose run this trace is, for the view header. */
  title?: string;
  /** The template-level error when the whole run failed (`ok:false`). */
  error?: string;
  /** The per-step trace when the run succeeded (`ok:true`). */
  steps?: TraceStep[];
  /** The run's final resolved output (`ok:true`). */
  output?: unknown;
}

/**
 * Extension -> trace view: the LOCAL slot is GATED because the form is currently INVALID
 * — required fields are missing, so running `execute()` would only produce garbage (an
 * error trace plus downstream noise). Rather than run it, the extension posts this. The
 * view shows a quiet placeholder listing the missing fields; when the extension still
 * holds a previous VALID trace it attaches it as `stale`, and the view keeps rendering
 * THAT trace under a slim "showing the last valid simulate" banner. The moment the form
 * validates, a normal `trace` message resumes and supersedes this.
 *
 * SELF-CONTAINED, deliberately: the stale trace rides IN the message rather than being
 * recovered from whatever the view showed before. A gated message is replayed on preview
 * focus-switch (and on view re-create), where the receiving view's local slot may be empty
 * or showing ANOTHER preview's trace — recovering from view state there would either lose
 * the last valid trace or leak another template's steps under this preview's banner.
 *
 * Only the LOCAL slot is ever gated: the explicit "Dry-run in Backstage" button is guarded
 * by RJSF's own submit validation and never reaches this path.
 */
export interface TraceGatedMessage {
  type: "traceGated";
  /** The template, for the view header. */
  title?: string;
  /** The missing required fields, by their schema `title` (falling back to the property name). */
  missing: string[];
  /**
   * The last VALID local trace for THIS preview, when one exists. Present → the view keeps
   * rendering it under the slim banner; absent → only the quiet placeholder shows.
   */
  stale?: { steps: TraceStep[]; output: unknown };
}

/**
 * Extension -> trace view: local simulate is UNAVAILABLE for the active preview because it
 * is a plain-YAML source (the buffer IS the artifact — there is no `template.ts` to run
 * through `execute()`). Fills the LOCAL slot with the same explanatory note the form panel
 * shows, so the Local tab reads as intentionally empty, not broken. The dry-run tab works
 * normally. Superseded by a `trace`/`traceGated` if the active preview later becomes a
 * `.ts` source (a different preview gains focus).
 */
export interface TraceLocalUnavailableMessage {
  type: "traceLocalUnavailable";
  /** The template, for the view header. */
  title?: string;
}

/**
 * Extension -> trace view: the form panel that drives this trace was closed (or none
 * is focused). Clears the view to its empty state so it doesn't show a stale run.
 */
export interface TraceClearMessage {
  type: "traceClear";
}

// --- Backstage dry-run: the second retained slot in the trace view -----------
//
// The trace view retains TWO slots side by side, switched by a header segmented control:
//   - LOCAL simulate (the `trace` / `traceGated` messages above) — the offline simulator.
//   - BACKSTAGE dry-run (the messages below) — a real POST to a live Backstage.
// A completed dry-run fills the dry-run slot and auto-switches the view to it; the user
// can flip back to Local anytime; both slots persist until replaced. The dry-run's
// presentation is built EXTENSION-side (pure `dryRunPresentation.ts`, unit-tested) and
// arrives here ready to render.
//
// NORMALIZED to the LOCAL trace schema. A successful dry-run's `steps` are normalized
// (by `dryRunTrace.ts`) into the SAME `TraceStep[]` the local trace uses — provenance
// pairing the compiled `${{ … }}` source against the values Backstage reported, the same
// prettified expressions — so ONE detail component renders both origins. The dry-run's
// EXTRAS (per-step log, emitted files, the endpoint header line) ride alongside.

/** One log line under a dry-run step (or the preamble) — the flattened `{ status?, message }`. */
export interface DryRunLogLine {
  status?: string;
  message: string;
}

/** One emitted file in a dry-run result — its path, exec bit, and decoded text (for the virtual doc). */
export interface DryRunFile {
  path: string;
  executable: boolean;
  /** The decoded file content (base64 already decoded extension-side). */
  content: string;
}

/** One server-side validation error from a 400, flattened for readable rendering. */
export interface DryRunValidationErrorView {
  /** A human location (`root` or the property path), e.g. `flavor` or `items[0].qty`. */
  where: string;
  message: string;
}

/**
 * The dry-run slot's header line: `Backstage dry-run · <baseUrl> · <status> · <duration>`.
 * `status` is the HTTP status for a completed request, or a taxonomy LABEL (e.g.
 * "unreachable") when the request never got an HTTP response. `durationMs` is measured
 * around the fetch. Present on every dry-run outcome so the slot always says WHERE it came
 * from and how the request fared.
 */
export interface DryRunEndpoint {
  baseUrl: string;
  /** The HTTP status text (e.g. "200") or a taxonomy label (e.g. "unreachable"). */
  status: string;
  durationMs: number;
}

/**
 * The dry-run slot's RUN-HISTORY indicator (item #4) — Backstage's template editor keeps a
 * list of submitted dry-runs you can flip between; we replicate it lightly. Rides on a
 * `dryRunResult` so the slot header can render `Run <index+1> of <total> · <time>` with ‹ ›
 * navigation. `index` is 0-based (the SELECTED run), `total` the count retained (capped),
 * `timestamp` epoch millis when THAT run completed, and `label` the taxonomy label so a
 * FAILED run in history reads as what it was. Absent on a `dryRunPending` (no completed run
 * yet) and on direct (test) callers that don't track history.
 */
export interface DryRunHistoryView {
  /** 0-based index of the selected run in the retained list. */
  index: number;
  /** Total runs retained (capped) — the "of N". */
  total: number;
  /** Epoch millis when the selected run completed (rendered as a wall-clock time). */
  timestamp: number;
  /** The selected run's taxonomy label, so a failed run is labeled in the indicator. */
  label: "ok" | "validationFailed" | "authFailed" | "error";
}

/**
 * Extension -> trace view: a Backstage dry-run OUTCOME, filling the DRY-RUN slot. The
 * `kind` discriminates the four rendered states:
 *   - `ok`               — the normalized `steps` (SAME `TraceStep[]` the local trace
 *                          uses — provenance-paired, each also carrying its `log` lines),
 *                          the `output`, the emitted `files`, and the `preamble` (task
 *                          banner) lines.
 *   - `validationFailed` — the readable `errors` state (the 400 `{ errors }`).
 *   - `authFailed`       — a single message pointing at the set-token command.
 *   - `error`            — unreachable / server error, as a single message line.
 * Every outcome carries `endpoint` for the slot header line; `history` (when tracked) drives
 * the run indicator + ‹ › navigation.
 */
export interface DryRunTraceMessage {
  type: "dryRunResult";
  title?: string;
  /** The result state (see the four arms above). */
  kind: "ok" | "validationFailed" | "authFailed" | "error";
  /** The slot header line — where it came from + how the request fared. */
  endpoint: DryRunEndpoint;
  /** The run-history position + label, when the extension tracks history (item #4). */
  history?: DryRunHistoryView;
  /** `ok`: the task-banner lines shown above the steps. */
  preamble?: DryRunLogLine[];
  /** `ok`: the per-step trace, normalized to the SAME shape as the local trace. */
  steps?: TraceStep[];
  /** `ok`: the run's final output. */
  output?: unknown;
  /** `ok`: the emitted files (decoded), for the Files section. */
  files?: DryRunFile[];
  /** `validationFailed`: the readable server-side errors. */
  errors?: DryRunValidationErrorView[];
  /** `authFailed` / `error`: the single message line to show. */
  message?: string;
}

/**
 * Extension -> trace view: a dry-run is IN FLIGHT (the POST was sent). Fills the DRY-RUN
 * slot with a "Running dry-run in Backstage…" placeholder AND auto-switches to it, so the
 * click has immediate feedback while the request is outstanding. Carries `baseUrl` so the
 * slot header can already name the endpoint. Superseded by the `dryRunResult` that follows.
 */
export interface DryRunPendingMessage {
  type: "dryRunPending";
  title?: string;
  /** The endpoint being contacted, for the pending slot header. */
  baseUrl?: string;
}

/**
 * Extension -> trace view: refresh ONLY the run-history indicator on the currently shown
 * dry-run result — WITHOUT replacing the shown run and WITHOUT auto-switching to the dry-run
 * tab (a full `dryRunResult` post does both). Sent when a STALE-for-display run completes
 * and is appended to history (see `recordCompletedRun` in lib/dryRunHistory.ts): the run the
 * user is looking at stays on display, but the total underneath it grew, so its `Run N of M`
 * must stay truthful. The view ignores this when the dry-run slot holds no completed result
 * (empty/pending — there is no indicator to refresh).
 */
export interface DryRunHistoryUpdateMessage {
  type: "dryRunHistoryUpdate";
  /** The shown run's refreshed history position (same run, new total). */
  history: DryRunHistoryView;
}

/** Every message the extension can post to the TRACE view. */
export type ExtensionToTraceView =
  | TraceMessage
  | TraceGatedMessage
  | TraceLocalUnavailableMessage
  | TraceClearMessage
  | DryRunTraceMessage
  | DryRunPendingMessage
  | DryRunHistoryUpdateMessage;

/**
 * Trace view -> extension: the trace React app has mounted AND subscribed. Posted
 * ONCE after the message listener attaches — the trace view's READY handshake, mirror
 * of the form panel's. The provider replays its buffered latest trace when this
 * arrives, so a run posted before the view's app had subscribed still lands (the same
 * mount/subscribe race the form panel has). The provider already buffers as `pending`;
 * `ready` makes the replay honest rather than timing-dependent.
 */
export interface TraceReadyMessage {
  type: "ready";
}

/**
 * Trace view -> extension: the user clicked an emitted dry-run file. The extension opens
 * its decoded content as a READ-ONLY virtual document (scheme `tdk-dryrun`). The path
 * identifies which file, and `content` is the decoded body the view already holds (so the
 * extension doesn't have to re-fetch or re-decode) — the view is the source of truth for
 * what it displayed.
 */
export interface OpenDryRunFileMessage {
  type: "openDryRunFile";
  path: string;
  content: string;
}

/**
 * Trace view -> extension: the user clicked a ‹ › run-history navigation button in the
 * dry-run slot header (item #4). `direction` is `prev` (one OLDER run) or `next` (one NEWER
 * run). The extension moves its per-preview history selection and REPLAYS the newly-selected
 * run into the dry-run slot through the SAME seq-guarded post path a real dry-run uses — a
 * navigation stamps the dry-run source afresh, so a stale in-flight dry-run can't clobber the
 * run the user navigated to. Navigation is intentionally EXTENSION-driven (not view-local
 * state) so the history survives tab flips + focus switches and stays the single source of
 * truth.
 */
export interface DryRunNavigateMessage {
  type: "dryRunNavigate";
  direction: "prev" | "next";
}

/** Every message the TRACE view can post to the extension. */
export type TraceViewToExtension = TraceReadyMessage | OpenDryRunFileMessage | DryRunNavigateMessage;
