// TDK form preview (issue #3) — a webview that renders a compiled template's
// PARAMETER FORM with RJSF + Fluent UI, live-updating as you edit. Its live
// execute() TRACE now streams to a separate "TDK Trace" panel view (see
// traceView.ts), not into this panel — so the form stays a clean form, and the trace
// is a real dockable debugger surface.
//
// This is BEHAVIORAL fidelity, not a Backstage skin: the goal is the right fields,
// pages, validation, and payload — not Backstage's exact look. The panel opens
// BESIDE the active `template.ts`, one panel per template file (re-running the
// command focuses the existing panel).
//
// THE PIPELINE. Compiling reuses the SAME `spawnTdk` path as the compile preview:
// `tdk compile <file>` for a saved buffer, `tdk compile --stdin <file>` piping the
// editor text for a DIRTY one — so the form reflects unsaved edits. We parse the
// YAML, take `spec.parameters` for the form AND keep `spec.steps` (whose `input`
// still holds the `${{ … }}` template strings — the SOURCE side of the trace's
// provenance). Edits to the previewed file recompile debounced (~300ms) and re-post
// to the webview. A failed compile posts a `compileError` instead — the webview
// keeps the last good form.
//
// PLAIN YAML TEMPLATES. The pipeline is source-agnostic after "compiled YAML", so a
// plain YAML Scaffolder template (apiVersion scaffolder.backstage.io/…, kind:
// Template — detected by core's `fromYaml`) previews too: the editor BUFFER is the
// artifact, no CLI compile, same debounce. The env selector, scenarios,
// save-as-scenario, and the local execute trace are TDK-compile concepts and are
// hidden/guarded for a `yaml` source (the webview shows a one-line note instead);
// the Backstage DRY-RUN works fully — it posts the parsed buffer entity as-is.
//
// ENV + SCENARIO are picked through NATIVE QuickPicks (the `tdk.formPreview.pickEnv`
// / `tdk.formPreview.pickScenario` commands, also reachable by clicking the header
// text). The env drives `-e <env>` because `load()` / `env.pick` bake env-specific
// data into the form; the scenario prefills parameter values + arms the trace with
// the scenario's step mocks. The commands target the LAST-FOCUSED form preview
// (tracked via `onDidChangeViewState`).
//
// SECURITY. A strict CSP with a per-panel nonce gates the one inline bootstrap and
// the bundled script (served via `asWebviewUri`); no remote content is allowed.

import * as crypto from "node:crypto";
import * as path from "node:path";
import { fromYaml } from "@tdk/core";
import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";
import { runDryRun } from "./dryRun.ts";
import { spawnTdk } from "./extension.ts";
import { BACKSTAGE_BASE_URL_KEY } from "./lib/backstageConfig.ts";
import { buildTraceSteps, type ResolvedStep, type SourceStep } from "./lib/buildTrace.ts";
import {
  type DryRunHistory,
  emptyHistory,
  type NavDirection,
  navigate,
  recordCompletedRun,
  tagSelected,
} from "./lib/dryRunHistory.ts";
import { insertScenario } from "./lib/insertScenario.ts";
import { toFormPages } from "./lib/pages.ts";
import { createSourceSeqGuard, type SourceSeqGuard } from "./lib/sourceSeqGuard.ts";
import type { TraceViewProvider } from "./traceView.ts";
import type {
  ExtensionToTraceView,
  ExtensionToWebview,
  ScenarioSummary,
  TemplateMessage,
  TemplateSource,
  TraceGatedMessage,
  TraceLocalUnavailableMessage,
  TraceMessage,
  WebviewToExtension,
} from "./webview/protocol.ts";

/** Debounce window for live (edit-triggered) recompiles — matches the compile preview. */
const FORM_DEBOUNCE_MS = 300;
/** Debounce window for the live trace — a touch longer, since each run spawns a CLI. */
const TRACE_DEBOUNCE_MS = 350;

/** The known env suggestions offered in the env QuickPick (free text also works). */
const KNOWN_ENVS = ["test", "prod"];

/** A scenario's step mocks, remembered extension-side to seed the live trace. */
type StepMocks = Record<string, { output: unknown }>;

/**
 * One live form-preview panel, keyed to a single template file. Owns its webview,
 * the env it is compiled for, the debounce timers, the discovered scenarios (+ the
 * selected scenario's step mocks that seed the live trace), the compiled SOURCE
 * steps (the `${{ … }}` provenance side), and the last form values (so a re-run of
 * the trace after an env/scenario change uses them).
 */
interface FormPreview {
  panel: vscode.WebviewPanel;
  /** The template file this panel previews. */
  sourcePath: string;
  /**
   * Where this preview's artifact comes from:
   *   - `tdk`  — a `.ts` template; the artifact is `tdk compile`'s output. The env
   *     selector, scenarios, save-as-scenario, and the local execute trace all apply.
   *   - `yaml` — a plain YAML Scaffolder template; the editor BUFFER is the artifact
   *     (no CLI compile). The env is fixed and the TDK-only affordances are hidden;
   *     dry-run still works (it posts the buffer entity as-is).
   */
  source: TemplateSource;
  /** The template's display title (for the header + the trace view header). */
  title: string;
  /** The env last compiled for (drives `-e` and the header text). */
  env: string;
  /** The currently selected scenario name (for the header + the trace fixture). */
  scenario?: string;
  /** Per-panel edit-debounce timer (recompile). */
  timer?: ReturnType<typeof setTimeout>;
  /** Per-panel trace-debounce timer (execute the current values). */
  traceTimer?: ReturnType<typeof setTimeout>;
  /**
   * The last LOCAL-slot state posted for THIS preview — a `trace` (a valid run), a
   * `traceGated` (the form is incomplete), or a `traceLocalUnavailable` (a YAML source has
   * no local simulate). Replayed into the shared trace view when the panel regains focus,
   * so switching between two form panels switches BOTH slots to this preview's last state
   * instead of leaving the other panel's (stale) run on display.
   */
  lastTrace?: TraceMessage | TraceGatedMessage | TraceLocalUnavailableMessage;
  /**
   * The last VALID local trace (an `ok:true` run). Kept apart from `lastTrace` so a
   * gating post can attach it as the `traceGated` message's `stale` payload — the gated
   * message is SELF-CONTAINED (see the protocol), so replaying it on focus-switch (or a
   * view re-create) restores the banner-over-last-valid-trace rendering without depending
   * on whatever the receiving view happened to show before.
   */
  lastValidTrace?: TraceMessage;
  /**
   * The last DRY-RUN-slot state posted for THIS preview (a `dryRunResult` or an
   * in-flight `dryRunPending`) — the dry-run counterpart to `lastTrace`. Replayed on
   * focus alongside `lastTrace` so a preview restores BOTH of its retained slots. For a
   * COMPLETED run this mirrors the history's selected entry; for an in-flight `dryRunPending`
   * (not a history entry) it is the pending message, so the pending slot restores on focus.
   */
  lastDryRun?: ExtensionToTraceView;
  /**
   * The per-preview dry-run RUN HISTORY (item #4) — a capped list of COMPLETED dry-run
   * results the user can flip between with ‹ ›. EVERY completed run is appended — even one
   * that finished after a newer stamp made it stale for display (a rapid resubmit, or a ‹ ›
   * navigation mid-flight): the seq guard gates only the auto-show, never the record. The
   * latest run auto-selects; a ‹ › navigation moves the selection and REPLAYS the selected
   * entry through the seq-guarded dry-run post path. The focus-switch replay restores the
   * SELECTED entry (so a preview returns to whichever run the user was viewing). Cleared
   * when the preview is disposed. The pure model (cap/append/navigate/label/record) is
   * `lib/dryRunHistory.ts`.
   */
  dryRunHistory: DryRunHistory;
  /** The scenarios discovered in the sibling `__fixtures__/scenarios.ts`. */
  scenarios: ScenarioSummary[];
  /** The selected scenario's step mocks — the trace's base fixture (undefined = none). */
  selectedSteps?: StepMocks;
  /** The compiled `spec.steps[]` — the SOURCE side of the trace provenance. */
  sourceSteps: SourceStep[];
  /** The last form values seen — re-run the trace against them after env/scenario changes. */
  lastValues: Record<string, unknown>;
  /**
   * The last validity the webview reported for `lastValues` (whether the form satisfies
   * every page's required list, and which fields are missing when not). Gates the local
   * simulate: `runTrace` runs `execute()` only when valid, and posts a `traceGated`
   * placeholder otherwise. Absent until the first `valuesChanged` — treated as valid, so an
   * env/scenario re-run before any edit still simulates.
   */
  lastValidity?: { valid: boolean; missing?: string[] };
  /**
   * The PER-SOURCE latest-wins guard — split so the two slots never race each other. A
   * local run stamps `"local"`, a dry-run stamps `"dryRun"`; each post fires only while it
   * is still its source's LATEST stamp. A SLOW older local run resolving after a newer one
   * can't clobber the fresher local trace (likewise per dry-run), and the two counters are
   * independent (the slots coexist), so a dry-run never invalidates a pending local run or
   * vice versa. The guard logic is the pure, unit-tested `createSourceSeqGuard`.
   */
  seqGuard: SourceSeqGuard;
  /**
   * Whether the webview has posted its `ready` handshake. Until it does, the initial
   * state we post is only BUFFERED (in `replay`, below) — the webview's message
   * listener attaches after its async mount, so an eager pre-ready post is lost. Once
   * `ready` arrives we flush the buffer and post eagerly thereafter.
   */
  ready: boolean;
  /**
   * The panel's replayable initial state, latest-per-type: the `template` (or its
   * `compileError`), the `scenarios`, and any `scenarioPrefill`. `post` records these
   * here and — on `ready` — (re)sends them in a stable order so the first render can
   * never be lost to the mount/subscribe race. A `Map` keyed by message `type` keeps
   * only the newest of each (a later successful compile supersedes an earlier error).
   */
  replay: Map<ExtensionToWebview["type"], ExtensionToWebview>;
}

/** Every open form preview, keyed by the template file's fsPath (one panel each). */
const previews = new Map<string, FormPreview>();

/** The last-focused form preview — the target of the palette env/scenario commands. */
let activePreview: FormPreview | undefined;

/** The trace view the previews post their runs to (set once on register). */
let traceView: TraceViewProvider | undefined;

/**
 * Register the `tdk.formPreview` command, the env/scenario QuickPick commands, and
 * the document-change listener that live-recompiles an open preview. `trace` is the
 * TDK Trace view the previews stream their runs to. Everything is pushed onto
 * `context.subscriptions` so it tears down with the extension.
 */
export function registerFormPreview(context: vscode.ExtensionContext, trace: TraceViewProvider): void {
  traceView = trace;
  // Wire the ‹ › run-history navigation: the trace app posts `dryRunNavigate`, which the
  // trace view forwards here to move the ACTIVE preview's history and replay the run.
  trace.setNavigateHandler(navigateDryRun);

  const command = vscode.commands.registerCommand("tdk.formPreview", () => openFormPreview(context));

  // The Test Explorer context action ("TDK: Open in Form Preview" on a SCENARIO
  // item): recover the template path + scenario name from the item id
  // (`<template.ts>::<scenario name>`, see extension.ts's `scenarioId`), open/focus
  // the panel for that template, and prefill it with the scenario.
  const openFromTest = vscode.commands.registerCommand("tdk.formPreview.openFromTest", (item?: vscode.TestItem) =>
    openFormPreviewFromTestItem(context, item),
  );

  // The native pickers (also reachable via the palette). They target the LAST-FOCUSED
  // form preview; with none open they explain that.
  const pickEnv = vscode.commands.registerCommand("tdk.formPreview.pickEnv", () => pickEnvFor(activePreview));
  const pickScenario = vscode.commands.registerCommand("tdk.formPreview.pickScenario", () =>
    pickScenarioFor(activePreview),
  );

  // Recompile a preview live as its template file is edited (debounced). Only files
  // with an open panel trigger work.
  const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
    const preview = previews.get(e.document.uri.fsPath);
    if (preview) scheduleRecompile(preview, e.document);
  });

  // Re-post the dry-run CAPABILITY to every open preview when `tdk.backstage.baseUrl`
  // changes (item #5) — setting or clearing the base URL LIVE enables/disables the Dry-run
  // button with no reload.
  const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(`tdk.${BACKSTAGE_BASE_URL_KEY}`)) return;
    for (const preview of previews.values()) postDryRunCapability(preview);
  });

  context.subscriptions.push(command, openFromTest, pickEnv, pickScenario, onChange, onConfig);
}

/** Whether Backstage dry-run is configured — solely whether `tdk.backstage.baseUrl` is set. */
function isDryRunConfigured(): boolean {
  const baseUrl = vscode.workspace.getConfiguration("tdk").get<string>(BACKSTAGE_BASE_URL_KEY);
  return typeof baseUrl === "string" && baseUrl.trim() !== "";
}

/** Post the current dry-run capability (configured or not) to a preview's form webview. */
function postDryRunCapability(preview: FormPreview): void {
  post(preview, { type: "dryRunCapability", configured: isDryRunConfigured() });
}

/**
 * Open/focus a form preview from a Test Explorer SCENARIO item and prefill it with
 * that scenario. The item's id is `<template fsPath>::<scenario name>` (built by
 * extension.ts's `scenarioId`), and its `uri` is the template file — we take the
 * template from the item's parent/uri and the name from the id suffix. A suite
 * (no `::`) or a missing item is ignored with a gentle message.
 */
async function openFormPreviewFromTestItem(
  context: vscode.ExtensionContext,
  item: vscode.TestItem | undefined,
): Promise<void> {
  if (!item) {
    vscode.window.showErrorMessage("TDK: run this from a scenario in the Testing view.");
    return;
  }
  const sep = item.id.indexOf("::");
  if (sep === -1) {
    vscode.window.showErrorMessage("TDK: open in form preview works on a SCENARIO, not a whole suite.");
    return;
  }
  // The template file: the suite item's uri (the scenario shares its parent's uri).
  const templatePath = item.parent?.uri?.fsPath ?? item.uri?.fsPath ?? item.id.slice(0, sep);
  const scenarioName = item.id.slice(sep + 2);
  await openFormPreview(context, { templatePath, scenarioName });
}

/** An optional prefill target when opening the preview from a Test Explorer scenario. */
interface PrefillTarget {
  templatePath: string;
  scenarioName: string;
}

/**
 * Open (or focus) the form preview for a `.ts` template OR a plain YAML Scaffolder
 * template. With no `prefill`, it uses the active editor (the `TDK: Open Form Preview`
 * command); with a `prefill`, it targets that template file (the Test Explorer context
 * action — always a `.ts` template) and prefills the named scenario. Re-running with a
 * panel already open just reveals it (and applies a fresh prefill if one was requested)
 * — one panel per template file.
 */
async function openFormPreview(context: vscode.ExtensionContext, prefill?: PrefillTarget): Promise<void> {
  const resolved = await resolveSourceDocument(prefill?.templatePath);
  if (!resolved) return;
  const { document, source } = resolved;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    vscode.window.showErrorMessage("TDK: the template must live inside an open workspace folder.");
    return;
  }

  const key = document.uri.fsPath;
  const existing = previews.get(key);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Beside);
    // A repeat open FROM a scenario re-applies the prefill against the fresh state.
    if (prefill) void applyScenarioPrefill(existing, prefill.scenarioName);
    return;
  }

  // A `.ts` template's panel is named for its directory (many templates are all named
  // `template.ts`); a YAML template's file name is itself distinctive.
  const panelName = source === "yaml" ? path.basename(key) : path.basename(path.dirname(key));

  const panel = vscode.window.createWebviewPanel(
    "tdkFormPreview",
    `Form: ${panelName}`,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      // Keep the React app + form state alive when the tab is hidden — re-rendering
      // from scratch on every tab switch would lose in-progress form values.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    },
  );

  const preview: FormPreview = {
    panel,
    sourcePath: key,
    source,
    title: panelName,
    env: "test",
    scenarios: [],
    sourceSteps: [],
    lastValues: {},
    seqGuard: createSourceSeqGuard(),
    dryRunHistory: emptyHistory(),
    ready: false,
    replay: new Map(),
  };
  previews.set(key, preview);
  activePreview = preview;
  panel.webview.html = formPreviewHtml(panel.webview, context.extensionUri);

  // Webview -> extension messages:
  //   ready         → the React app subscribed; flush the buffered initial state (the
  //                   HANDSHAKE — the fix for the blank form on first open).
  //   valuesChanged → run one execute() for the current values and post a `trace` to
  //                   the TDK Trace view (TDK sources only — the local simulator needs
  //                   a `.ts` template; a YAML source just remembers the values for the
  //                   dry-run).
  //   pickEnv       → open the native env QuickPick for this preview (TDK-only).
  //   pickScenario  → open the native scenario QuickPick for this preview (TDK-only).
  //   saveScenario  → capture the current values into __fixtures__/scenarios.ts (TDK-only).
  //   dryRunSubmit  → POST to Backstage — works for BOTH sources (a YAML source posts
  //                   the parsed buffer entity as-is).
  // The webview already hides the TDK-only affordances for a YAML source; the guards
  // here are the extension-side belt to that suspender.
  panel.webview.onDidReceiveMessage((message: WebviewToExtension) => {
    if (message.type === "ready") {
      flushReplay(preview);
    } else if (message.type === "valuesChanged") {
      const values = (message.values ?? {}) as Record<string, unknown>;
      preview.lastValues = values;
      preview.lastValidity =
        message.valid === false ? { valid: false, missing: message.missing ?? [] } : { valid: true };
      // GATE the local simulate: run execute() only when the form is complete. An
      // incomplete form posts a `traceGated` placeholder instead of a garbage run.
      if (preview.source === "tdk") scheduleTrace(preview, values);
    } else if (message.type === "pickEnv") {
      if (preview.source === "tdk") void pickEnvFor(preview);
    } else if (message.type === "pickScenario") {
      if (preview.source === "tdk") void pickScenarioFor(preview);
    } else if (message.type === "saveScenario") {
      if (preview.source === "tdk") void saveScenario(preview, (message.values ?? {}) as Record<string, unknown>);
    } else if (message.type === "dryRunSubmit") {
      void submitDryRun(context, preview, (message.values ?? {}) as Record<string, unknown>);
    }
  });

  // Track the last-focused preview so the palette env/scenario commands target it —
  // and replay BOTH of ITS retained slots (the local trace/gating AND the last dry-run)
  // into the shared view, so switching between two form panels restores this preview's
  // full trace state instead of leaving the other panel's (stale) runs on display.
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active && activePreview !== preview) {
      activePreview = preview;
      // Replay the dry-run slot, then the local slot — the view's per-source retention
      // keeps both regardless of order. Note the resulting ACTIVE tab: a dry-run replay
      // auto-switches the view to the dry-run tab (dryRunResult/dryRunPending always do),
      // and a local replay does not switch back — so a preview that has ever dry-run
      // lands on its dry-run tab, and one that hasn't lands on Local. The gated local
      // state is SELF-CONTAINED (its stale trace rides in the message), so this replay
      // renders identically whatever the view showed before.
      //
      // The dry-run replay restores the SELECTED history run: if one is selected we re-tag
      // it fresh (accurate `Run N of M`, even after stale appends grew the total), else we
      // fall back to `lastDryRun` (which covers an in-flight `dryRunPending` — not a history
      // entry). Self-contained, like PR #77's gated replay: the run rides in the message,
      // not view state.
      const dryRun = tagSelected(preview.dryRunHistory) ?? preview.lastDryRun;
      if (dryRun) traceView?.post(dryRun);
      if (preview.lastTrace) traceView?.post(preview.lastTrace);
    }
  });

  panel.onDidDispose(() => {
    if (preview.timer) clearTimeout(preview.timer);
    if (preview.traceTimer) clearTimeout(preview.traceTimer);
    // Invalidate any in-flight run of EITHER source so it never posts to the disposed
    // webview (a fresh stamp makes every outstanding token stale).
    preview.seqGuard.stamp("local");
    preview.seqGuard.stamp("dryRun");
    previews.delete(key);
    fullScenarios.delete(key);
    // Drop the dry-run history — it belonged to this now-disposed preview.
    preview.dryRunHistory = emptyHistory();
    if (activePreview === preview) activePreview = undefined;
    // The trace view now shows a run for a closed panel — clear it, unless ANOTHER
    // preview is still active (so closing one of several panels doesn't blank a live
    // trace the user is still driving from another).
    if (!activePreview) traceView?.clear();
  });

  // Post the dry-run capability with the initial state so the Dry-run button starts in the
  // right enabled/disabled state (item #5). Buffered until `ready`, like the other initial
  // state, so it survives the mount/subscribe race.
  postDryRunCapability(preview);

  await compileAndPost(preview, document);
  // Discover scenarios (parameters + step mocks) and populate the picker. Then, if
  // this open came from a Test Explorer scenario, prefill it. Scenarios live in a
  // sibling __fixtures__/scenarios.ts — a TDK concept, so a YAML source skips this.
  if (preview.source === "tdk") {
    await loadAndPostScenarios(preview);
    if (prefill) await applyScenarioPrefill(preview, prefill.scenarioName);
  }
}

/** A resolved preview target: the document + whether it is a `.ts` (tdk) or YAML template. */
interface ResolvedSource {
  document: vscode.TextDocument;
  source: TemplateSource;
}

/** Whether a document is a `.ts` file (by language id or extension). */
function isTypeScript(document: vscode.TextDocument): boolean {
  return document.languageId === "typescript" || document.fileName.endsWith(".ts");
}

/** Whether a document is a `.yaml`/`.yml` file (by language id or extension). */
function isYamlFile(document: vscode.TextDocument): boolean {
  return document.languageId === "yaml" || document.fileName.endsWith(".yaml") || document.fileName.endsWith(".yml");
}

/**
 * Resolve the template document to preview: from an explicit `templatePath` (the Test
 * Explorer action — always a `.ts` template) or the active editor (the command). The
 * active editor may be a `.ts` template (source `tdk`) OR a plain YAML file that IS a
 * Scaffolder template (source `yaml`) — the adoption path for teammates who author
 * templates as YAML, not TypeScript. Anything else surfaces an actionable message that
 * names BOTH accepted kinds, never just "open a .ts template".
 */
async function resolveSourceDocument(templatePath?: string): Promise<ResolvedSource | undefined> {
  if (templatePath) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(templatePath));
      return { document, source: "tdk" };
    } catch {
      vscode.window.showErrorMessage(`TDK: could not open ${templatePath}.`);
      return undefined;
    }
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("TDK: open a .ts template or a YAML Scaffolder template first.");
    return undefined;
  }
  const document = editor.document;
  if (isTypeScript(document)) return { document, source: "tdk" };
  // A YAML file only qualifies when it actually parses as a Scaffolder template —
  // otherwise the same message a non-template editor gets (never "open a .ts template"
  // for a valid YAML template).
  if (isYamlFile(document)) {
    const detected = fromYaml(document.getText());
    if (detected.kind === "notTemplate") {
      vscode.window.showErrorMessage(
        "TDK: this YAML is not a Scaffolder template (needs apiVersion scaffolder.backstage.io/… and kind: Template).",
      );
      return undefined;
    }
    // A `template` or a `parseError` (a genuine template with a syntax error) both open —
    // a parse error renders in the compile-error banner, keeping the last good form.
    return { document, source: "yaml" };
  }
  vscode.window.showErrorMessage("TDK: the active editor must be a .ts template or a YAML Scaffolder template.");
  return undefined;
}

/** Debounce a live recompile for one preview after its template file changed. */
function scheduleRecompile(preview: FormPreview, source: vscode.TextDocument): void {
  if (preview.timer) clearTimeout(preview.timer);
  preview.timer = setTimeout(() => {
    preview.timer = undefined;
    void compileAndPost(preview, source);
  }, FORM_DEBOUNCE_MS);
}

/**
 * Produce the preview's compiled-YAML ARTIFACT (or an error). The SINGLE artifact path —
 * shared by `compileAndPost` (the form) and the dry-run submit, so both see the exact
 * same artifact.
 *
 *   - A `tdk` source compiles through the CLI: `--stdin` (piping the editor buffer) when
 *     a matching document is DIRTY so the result tracks unsaved edits, else
 *     `compile <file>` on disk.
 *   - A `yaml` source needs NO compile — the (live, possibly unsaved) buffer text IS the
 *     artifact, so this just returns it. The dry-run therefore posts the parsed buffer
 *     entity as-is.
 */
async function compileYaml(
  preview: FormPreview,
  source?: vscode.TextDocument,
): Promise<{ ok: true; yaml: string } | { ok: false; error: string }> {
  const uri = vscode.Uri.file(preview.sourcePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return { ok: false, error: "the template must live inside an open workspace folder." };

  const doc = source ?? findOpenDocument(preview.sourcePath);

  if (preview.source === "yaml") {
    // The buffer is the artifact — no CLI spawn. Fall back to the on-disk file when the
    // document is no longer open (e.g. the editor tab was closed but the panel lives on).
    if (doc) return { ok: true, yaml: doc.getText() };
    try {
      const opened = await vscode.workspace.openTextDocument(uri);
      return { ok: true, yaml: opened.getText() };
    } catch {
      return { ok: false, error: `could not read ${preview.sourcePath}.` };
    }
  }

  const args = ["compile", "-e", preview.env, preview.sourcePath];
  const dirty = doc?.isDirty ?? false;
  const stdinArgs = ["compile", "--stdin", "-e", preview.env, preview.sourcePath];

  const { code, stdout, stderr } =
    dirty && doc ? await spawnTdk(folder, stdinArgs, doc.getText()) : await spawnTdk(folder, args);

  if (code !== 0) return { ok: false, error: stderr.trim() || `tdk compile exited with code ${code}.` };
  return { ok: true, yaml: stdout };
}

/**
 * Produce the preview's artifact (compile for `tdk`, the buffer for `yaml`) and post the
 * result to the webview. A failed compile — or, for a YAML source, a syntax error
 * (reported `file:line` when the parser locates it) — posts a `compileError`: the webview
 * shows the banner and keeps the last good form. On success it also stashes the
 * `spec.steps[]` — the `${{ … }}` SOURCE side of the trace provenance (TDK sources; a
 * YAML source stashes them too, though its local trace never runs). `source`, when given,
 * is the just-changed document (so we don't re-scan the workspace for it).
 */
async function compileAndPost(preview: FormPreview, source?: vscode.TextDocument): Promise<void> {
  const uri = vscode.Uri.file(preview.sourcePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return;

  const result = await compileYaml(preview, source);
  if (!result.ok) {
    post(preview, { type: "compileError", message: result.error });
    return;
  }
  const stdout = result.yaml;

  // A YAML source: re-detect on every (debounced) edit. The detector gives the richer
  // failure story — a syntax error carries its line (`file:line: message`, the same
  // shape the TS compile errors use), and an edit that removed `apiVersion`/`kind`
  // reads as "no longer a Scaffolder template", not a cryptic missing-form.
  if (preview.source === "yaml") {
    const detected = fromYaml(stdout);
    if (detected.kind === "parseError") {
      const where = detected.line !== undefined ? `${preview.sourcePath}:${detected.line}: ` : "";
      post(preview, { type: "compileError", message: `${where}${detected.message}` });
      return;
    }
    if (detected.kind === "notTemplate") {
      post(preview, {
        type: "compileError",
        message:
          "This YAML is not a Scaffolder template (needs apiVersion scaffolder.backstage.io/… and kind: Template).",
      });
      return;
    }
    // `fromYaml` hands back the parsed entity as `object`; the form fields come from the
    // same `spec.parameters` / `metadata` the TDK path reads (below), just without a
    // compile step — the YAML buffer IS the artifact. Read defensively: the gate only
    // guaranteed apiVersion + kind, not a well-formed spec.
    const entity = detected.object as {
      metadata?: { name?: string; title?: string };
      spec?: { parameters?: unknown; steps?: unknown };
    };
    const pages = toFormPages(entity.spec?.parameters);
    preview.sourceSteps = normalizeSourceSteps(entity.spec?.steps);
    preview.title = entity.metadata?.title ?? entity.metadata?.name ?? path.basename(preview.sourcePath);
    const message: TemplateMessage = {
      type: "template",
      templateId: preview.sourcePath,
      title: preview.title,
      env: preview.env,
      source: "yaml",
      pages,
    };
    post(preview, message);
    return;
  }

  try {
    const parsed = parseYaml(stdout) as {
      metadata?: { name?: string; title?: string };
      spec?: { parameters?: unknown; steps?: unknown };
    };
    const pages = toFormPages(parsed.spec?.parameters);
    preview.sourceSteps = normalizeSourceSteps(parsed.spec?.steps);
    preview.title = parsed.metadata?.title ?? parsed.metadata?.name ?? path.basename(preview.sourcePath);
    const message: TemplateMessage = {
      type: "template",
      templateId: preview.sourcePath,
      title: preview.title,
      env: preview.env,
      source: "tdk",
      pages,
    };
    post(preview, message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post(preview, { type: "compileError", message: `Could not parse compiled YAML: ${message}` });
  }
}

/**
 * The order the buffered initial-state messages replay in on `ready`: the template (or
 * its error) first, then the scenario list, then any scenario prefill (which merges
 * over the template's default values), then the dry-run capability (whether the Dry-run
 * button is enabled — item #5). A stable order keeps the first render deterministic.
 * `compileError` shares the `template` slot — the webview treats one as superseding the
 * other — so the map key collapses them and only the latest shows. `dryRunCapability` is
 * buffered too so the button's INITIAL disabled/enabled state survives the mount/subscribe
 * race (an eager pre-`ready` post would be dropped), and later live changes re-post it.
 */
const REPLAY_ORDER: readonly ExtensionToWebview["type"][] = [
  "template",
  "compileError",
  "scenarios",
  "scenarioPrefill",
  "dryRunCapability",
];

/**
 * Post a typed message to the preview's webview. The four initial-state message types
 * are also RECORDED (latest-per-type) into `preview.replay` so they can be re-sent on
 * the `ready` handshake. Until the webview is `ready`, those are ONLY buffered — an
 * eager post before the app's listener attaches would be dropped (the blank-form race);
 * everything else (and everything once ready) posts eagerly.
 */
function post(preview: FormPreview, message: ExtensionToWebview): void {
  if (REPLAY_ORDER.includes(message.type)) preview.replay.set(message.type, message);
  if (preview.ready || !REPLAY_ORDER.includes(message.type)) void preview.panel.webview.postMessage(message);
}

/**
 * Handle the `ready` handshake: mark the panel ready and (re)play its buffered initial
 * state in `REPLAY_ORDER`. Idempotent — a second `ready` (e.g. after the webview was
 * re-created) simply re-sends the current buffer, which is what a reload needs.
 */
function flushReplay(preview: FormPreview): void {
  preview.ready = true;
  for (const type of REPLAY_ORDER) {
    const message = preview.replay.get(type);
    if (message) void preview.panel.webview.postMessage(message);
  }
}

/** The open text document for a path, if VS Code already has it loaded (for `isDirty`). */
function findOpenDocument(fsPath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
}

/** Narrow the parsed `spec.steps` to the `{ id, input }` list the trace provenance needs. */
function normalizeSourceSteps(steps: unknown): SourceStep[] {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({ id: typeof s.id === "string" ? s.id : undefined, input: s.input }));
}

// --- Native pickers (env + scenario) -----------------------------------------

/**
 * Open the native ENV QuickPick for a preview: the known envs as items plus an
 * "Other…" option that free-texts a name via an InputBox (the DSL's `env.pick`/`load`
 * examples use "test"/"prod", but any env name is valid). Picking recompiles for the
 * chosen env and re-runs the trace against the last values. No open preview → a
 * gentle info message; a YAML preview likewise (its artifact is already fixed — the
 * env is a TDK-compile concept).
 */
async function pickEnvFor(preview: FormPreview | undefined): Promise<void> {
  if (!preview) {
    vscode.window.showInformationMessage("TDK: open a form preview first (TDK: Open Form Preview).");
    return;
  }
  if (preview.source === "yaml") {
    vscode.window.showInformationMessage("TDK: a YAML template is already fixed — envs apply to template.ts sources.");
    return;
  }
  const OTHER = "Other…";
  const items: vscode.QuickPickItem[] = KNOWN_ENVS.map((e) => ({
    label: e,
    description: e === preview.env ? "current" : undefined,
  }));
  items.push({ label: OTHER, description: "enter an env name" });
  const picked = await vscode.window.showQuickPick(items, {
    title: "Compile the form for which env?",
    placeHolder: "load() / env.pick bake env-specific data into the form",
  });
  if (!picked) return;

  let env = picked.label;
  if (env === OTHER) {
    const typed = await vscode.window.showInputBox({
      title: "Env name",
      prompt: "The env to compile the form for",
      value: preview.env,
      validateInput: (v) => (v.trim() ? undefined : "Enter an env name."),
    });
    if (!typed) return;
    env = typed.trim();
  }
  if (env === preview.env) return;
  preview.env = env;
  await compileAndPost(preview);
  await loadAndPostScenarios(preview);
  // Re-run the trace for the new env against the current values.
  scheduleTrace(preview, preview.lastValues);
}

/**
 * Open the native SCENARIO QuickPick for a preview: the discovered scenarios as items
 * (a hint marks those that arm the trace with step mocks). Picking prefills the form
 * and arms the trace. No scenarios → an info message; no open preview → likewise.
 */
async function pickScenarioFor(preview: FormPreview | undefined): Promise<void> {
  if (!preview) {
    vscode.window.showInformationMessage("TDK: open a form preview first (TDK: Open Form Preview).");
    return;
  }
  if (preview.source === "yaml") {
    vscode.window.showInformationMessage("TDK: scenarios live in __fixtures__/scenarios.ts — a template.ts feature.");
    return;
  }
  if (preview.scenarios.length === 0) {
    vscode.window.showInformationMessage("TDK: this template has no scenarios in __fixtures__/scenarios.ts.");
    return;
  }
  const items: vscode.QuickPickItem[] = preview.scenarios.map((s) => ({
    label: s.name,
    description: s.name === preview.scenario ? "current" : undefined,
    detail: s.hasStepMocks ? "arms the trace with this scenario's step mocks" : undefined,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Prefill the form from which scenario?",
    placeHolder: "from __fixtures__/scenarios.ts",
  });
  if (!picked) return;
  await applyScenarioPrefill(preview, picked.label);
}

// --- Scenarios, the live trace, and save-as-scenario -------------------------

/** The additive scenario shape `tdk execute` reports (mirrored — we never import core). */
interface ExecuteScenarioReport {
  name?: string;
  branches?: string[];
  parameters?: unknown;
  hasStepMocks?: boolean;
  steps?: StepMocks;
}

/** The `tdk execute` report shape (a mirror; we never import core). */
interface ExecuteReportShape {
  ok?: boolean;
  scenarios?: ExecuteScenarioReport[];
}

/** The `tdk execute --fixture-stdin` report shape (a mirror). */
interface InlineReportShape {
  ok?: boolean;
  error?: string;
  result?: { steps?: Record<string, ResolvedStep>; output?: unknown };
}

/**
 * Run `tdk execute <template>` once, read the scenario list (name + branches +
 * parameters + step mocks — the additive fields the CLI now reports), stash the
 * mocks so `applyScenarioPrefill` / the trace can reuse them, and post a `scenarios`
 * message to the webview. A spawn/parse failure (or a template with no fixtures)
 * simply leaves the list empty — the form still works.
 */
async function loadAndPostScenarios(preview: FormPreview): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(preview.sourcePath));
  if (!folder) return;
  const { code, stdout } = await spawnTdk(folder, ["execute", "-e", preview.env, preview.sourcePath]);
  if (code !== 0) return;

  let report: ExecuteReportShape;
  try {
    report = JSON.parse(stdout) as ExecuteReportShape;
  } catch {
    return;
  }
  const raw = report.scenarios ?? [];
  const summaries: ScenarioSummary[] = raw.map((s, i) => ({
    name: s.name ?? `scenario ${i + 1}`,
    branches: s.branches,
    parameters: (s.parameters ?? undefined) as Record<string, unknown> | undefined,
    hasStepMocks: Boolean(s.hasStepMocks),
  }));
  // Keep the FULL scenario reports (with step mocks) for the trace's base fixture.
  fullScenarios.set(preview.sourcePath, raw);
  preview.scenarios = summaries;
  post(preview, { type: "scenarios", scenarios: summaries });
}

/** The full `tdk execute` scenario reports per template — the source of step mocks. */
const fullScenarios = new Map<string, ExecuteScenarioReport[]>();

/**
 * Apply a scenario's prefill: find it (by name) in the loaded reports, remember its
 * step mocks (so the live trace runs with the same mocked outputs), and post a
 * `scenarioPrefill` with its parameter values (the webview merges them and returns
 * to page 1). An unknown name is a quiet no-op.
 */
async function applyScenarioPrefill(preview: FormPreview, name: string): Promise<void> {
  // Scenarios may not have loaded yet (a very fast Test Explorer action) — load them.
  if (!fullScenarios.has(preview.sourcePath)) await loadAndPostScenarios(preview);
  const reports = fullScenarios.get(preview.sourcePath) ?? [];
  const found = reports.find((s, i) => (s.name ?? `scenario ${i + 1}`) === name);
  if (!found) return;
  preview.selectedSteps = found.hasStepMocks ? found.steps : undefined;
  preview.scenario = name;
  const values = (found.parameters ?? {}) as Record<string, unknown>;
  post(preview, { type: "scenarioPrefill", name, values });
}

/** Debounce a live trace run for the current form values. */
function scheduleTrace(preview: FormPreview, values: Record<string, unknown>): void {
  if (preview.traceTimer) clearTimeout(preview.traceTimer);
  preview.traceTimer = setTimeout(() => {
    preview.traceTimer = undefined;
    void runTrace(preview, values);
  }, TRACE_DEBOUNCE_MS);
}

/**
 * Run ONE `execute()` for the current form values and post an enriched `trace` to the
 * TDK Trace view. The base fixture reuses the selected scenario's step mocks (if any)
 * with `parameters` REPLACED by the live values; with no scenario selected it is
 * `{ parameters }` alone. Each step is enriched by `buildTraceSteps` with its
 * provenance (compiled `${{ … }}` source paired with resolved value) and its context
 * (parameters + prior steps' outputs). A template-level failure posts `ok:false`.
 */
async function runTrace(preview: FormPreview, values: Record<string, unknown>): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(preview.sourcePath));
  if (!folder) return;

  // Stamp this run against the LOCAL sequence; post only while it is still the latest
  // LOCAL run AND this preview is still the active one. A slow older execute resolving
  // after a newer one must not overwrite the fresher local trace, and a background preview
  // must not hijack the shared trace view from the one the user is looking at. The dry-run
  // slot has its own sequence — the two never race each other.
  const seq = preview.seqGuard.stamp("local");
  const postIfCurrent = (msg: TraceMessage | TraceGatedMessage): void => {
    if (!preview.seqGuard.isLatest("local", seq)) return;
    // Remember the LOCAL-slot state per-preview (for the focus-switch replay) even while
    // this panel is in the background; only the ACTIVE preview drives the shared view. A
    // valid run also becomes `lastValidTrace` — the thing a later gating placeholder keeps
    // showing under its banner.
    preview.lastTrace = msg;
    if (msg.type === "trace" && msg.ok) preview.lastValidTrace = msg;
    if (activePreview === preview) traceView?.post(msg);
  };

  // VALIDITY GATE. When the form is incomplete, do NOT run `execute()` — it would only
  // produce an error trace + downstream noise. Post a `traceGated` placeholder instead:
  // the view shows the missing fields, keeping the last valid trace (if any) under a
  // banner. The stale trace rides IN the message (self-contained — see the protocol), so
  // replaying it on focus-switch or a view re-create never depends on the receiving
  // view's prior state. The moment the form validates, this branch is skipped and a
  // normal run resumes.
  if (preview.lastValidity && preview.lastValidity.valid === false) {
    const valid = preview.lastValidTrace;
    postIfCurrent({
      type: "traceGated",
      title: preview.title,
      missing: preview.lastValidity.missing ?? [],
      stale: valid ? { steps: valid.steps ?? [], output: valid.output } : undefined,
    });
    return;
  }

  const fixture: Record<string, unknown> = { parameters: values };
  if (preview.selectedSteps) fixture.steps = preview.selectedSteps;

  const { code, stdout, stderr } = await spawnTdk(
    folder,
    ["execute", "--fixture-stdin", "-e", preview.env, preview.sourcePath],
    JSON.stringify(fixture),
  );
  if (code === -1) {
    postIfCurrent({
      type: "trace",
      ok: false,
      title: preview.title,
      error: stderr.trim() || "tdk execute could not be spawned.",
    });
    return;
  }

  let report: InlineReportShape;
  try {
    report = JSON.parse(stdout) as InlineReportShape;
  } catch {
    postIfCurrent({
      type: "trace",
      ok: false,
      title: preview.title,
      error: stderr.trim() || `Could not parse execute output.`,
    });
    return;
  }

  if (!report.ok || !report.result) {
    postIfCurrent({ type: "trace", ok: false, title: preview.title, error: report.error ?? "The run failed." });
    return;
  }
  const resolved: ResolvedStep[] = Object.entries(report.result.steps ?? {}).map(([id, step]) => ({
    id,
    skipped: step.skipped,
    // A halted run marks downstream steps `notReached` (no input/output) — carry the flag
    // so the rail shows the distinct "not reached" glyph instead of a misleading "ran".
    notReached: step.notReached,
    input: step.input,
    output: step.output,
    error: step.error,
  }));
  const steps = buildTraceSteps(resolved, preview.sourceSteps, values);
  postIfCurrent({ type: "trace", ok: true, title: preview.title, steps, output: report.result.output });
}

/**
 * Submit a Backstage dry-run of the CURRENT env's template with the form's live values.
 * Delegates to `runDryRun` (the extension-host orchestration): it checks the setup,
 * compiles via the SAME `compileYaml` pipeline the form uses, POSTs to Backstage, and
 * renders the classified outcome in the TDK Trace view — as a distinct Backstage-origin
 * result. `fetch` is the runtime global (VS Code's host has it); the client is pure and
 * takes it injected. No trace view (shouldn't happen once registered) is a quiet no-op.
 */
async function submitDryRun(
  context: vscode.ExtensionContext,
  preview: FormPreview,
  values: Record<string, unknown>,
): Promise<void> {
  if (!traceView) return;
  // A dry-run is the ACTIVE thing the user is looking at — make this preview active so
  // its later runs (and the focus-switch replay) target the same view.
  activePreview = preview;
  // A YAML source has no local simulate — seed the LOCAL slot with the explanatory note so
  // the Local tab reads as intentionally empty (not broken) once the dry-run reveals the
  // view. Retain it as `lastTrace` so the focus-switch replay restores it too.
  if (preview.source === "yaml" && preview.lastTrace === undefined) {
    const note: TraceLocalUnavailableMessage = { type: "traceLocalUnavailable", title: preview.title };
    preview.lastTrace = note;
    traceView.post(note);
  }
  // Stamp the dry-run against the DRY-RUN sequence (its own, independent of the local
  // one): a slow POST resolving after a newer dry-run must not clobber the fresher dry-run
  // DISPLAY — but it never touches the local slot, and a local edit never invalidates this
  // in-flight dry-run. The latest run is also retained as `lastDryRun` for the focus-switch
  // replay, so switching previews restores BOTH slots.
  const seq = preview.seqGuard.stamp("dryRun");
  const emit = (message: ExtensionToTraceView): void => {
    const latest = preview.seqGuard.isLatest("dryRun", seq);
    if (message.type !== "dryRunResult") {
      // A `dryRunPending` placeholder is DISPLAY-ONLY (no completed run yet) — a stale one
      // is simply dropped; the latest becomes `lastDryRun` so a focus-switch restores it.
      if (!latest) return;
      preview.lastDryRun = message;
      if (activePreview === preview) traceView?.post(message);
      return;
    }
    // A COMPLETED result is appended to the run HISTORY *unconditionally* — the user paid
    // Backstage for this run, and a re-stamp while it was in flight (a second rapid submit,
    // or a ‹ › navigation) must never lose it. `isLatest` gates only the DISPLAY: the
    // latest run auto-shows (tagged `Run N of M · time`); a stale one leaves the shown run
    // alone and just refreshes its indicator count (the total grew underneath it — see
    // `recordCompletedRun` and the `dryRunHistoryUpdate` protocol note).
    const recorded = recordCompletedRun(preview.dryRunHistory, message, Date.now(), latest);
    preview.dryRunHistory = recorded.history;
    if (recorded.show) {
      preview.lastDryRun = recorded.show;
      if (activePreview === preview) traceView?.post(recorded.show);
    } else if (recorded.indicatorUpdate && activePreview === preview) {
      traceView?.post({ type: "dryRunHistoryUpdate", history: recorded.indicatorUpdate });
    }
  };
  await runDryRun(
    context,
    { title: preview.title, values, sourceSteps: preview.sourceSteps, compile: () => compileYaml(preview) },
    traceView,
    fetch as unknown as import("@tdk/core/backstage").FetchLike,
    emit,
  );
}

/**
 * NAVIGATE the ACTIVE preview's dry-run history by one step (‹ prev / › next) and REPLAY the
 * newly-selected run into the dry-run slot through the SAME seq-guarded post path a fresh
 * dry-run uses: a navigation stamps the dry-run source anew, so a slow in-flight dry-run
 * resolving later is stale FOR DISPLAY and cannot clobber the run the user navigated to
 * (it still lands in history — see `submitDryRun`'s emit). The replayed message becomes
 * `lastDryRun`, so a focus-switch restores the same navigated run. A no-op when there is no
 * active preview, no history, or the selection is already at the end.
 */
function navigateDryRun(direction: NavDirection): void {
  const preview = activePreview;
  if (!preview) return;
  const before = preview.dryRunHistory.selected;
  preview.dryRunHistory = navigate(preview.dryRunHistory, direction);
  if (preview.dryRunHistory.selected === before) return; // clamped at an end — nothing to do
  // Stamp afresh so a still-in-flight dry-run's later resolve is display-stale against THIS.
  preview.seqGuard.stamp("dryRun");
  const message = tagSelected(preview.dryRunHistory);
  if (!message) return;
  preview.lastDryRun = message;
  if (activePreview === preview) traceView?.post(message);
}

/**
 * Save the current form values as a NEW scenario in the template's sibling
 * `__fixtures__/scenarios.ts`. Prompts for a name, inserts an entry via the PURE
 * `insertScenario` AST transform (preserving the file's indentation + comma style),
 * and writes the file. On an unrecognized file shape (no exported `scenarios`
 * array), it never corrupts the file — it opens the snippet in an untitled document
 * so the user can place it by hand.
 */
async function saveScenario(preview: FormPreview, values: Record<string, unknown>): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Save form as scenario",
    prompt: "A name for the new scenario",
    placeHolder: "e.g. wedding order with a gold ribbon",
    validateInput: (v) => (v.trim() ? undefined : "Enter a scenario name."),
  });
  if (!name) return; // cancelled

  const scenariosPath = path.join(path.dirname(preview.sourcePath), "__fixtures__", "scenarios.ts");
  const uri = vscode.Uri.file(scenariosPath);

  // Transform the LIVE buffer, not the disk file: if the user has scenarios.ts open
  // with UNSAVED edits, a disk-based transform replacing the buffer would silently
  // clobber those edits with a splice of the stale on-disk text. `openTextDocument`
  // returns the open (possibly dirty) buffer — or loads from disk when not open —
  // so the transform and the replace below always see the same content.
  let doc: vscode.TextDocument | undefined;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    doc = undefined; // no scenarios file yet → fall back to a snippet
  }

  const next = doc !== undefined ? insertScenario(doc.getText(), name.trim(), values) : undefined;
  if (doc === undefined || next === undefined) {
    // Fall back to an untitled document with the snippet — NEVER a partial write.
    await openScenarioSnippet(name.trim(), values, doc === undefined ? "no scenarios.ts yet" : "unrecognized file");
    return;
  }

  // Apply as a workspace edit so it participates in undo and refreshes open editors.
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(uri, fullRange, next);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    await doc.save();
    vscode.window.showInformationMessage(`TDK: saved scenario "${name.trim()}".`);
    // Refresh the picker with the new scenario.
    await loadAndPostScenarios(preview);
  } else {
    await openScenarioSnippet(name.trim(), values, "the edit could not be applied");
  }
}

/**
 * Open an untitled TypeScript document holding a standalone scenario snippet — the
 * fallback when the scenarios file can't be edited safely. The user places it by
 * hand; we never risk corrupting a file we don't understand.
 */
async function openScenarioSnippet(name: string, values: Record<string, unknown>, why: string): Promise<void> {
  const snippet = `// TDK: paste this scenario into your __fixtures__/scenarios.ts (${why}).\n${JSON.stringify(
    { name, fixture: { parameters: values } },
    null,
    2,
  )}\n`;
  const doc = await vscode.workspace.openTextDocument({ language: "typescript", content: snippet });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
}

/**
 * The panel HTML: a strict CSP with a per-load nonce, the bundled webview script
 * served through `asWebviewUri`, and a mount point. No remote content is allowed —
 * `default-src 'none'`, script ELEMENTS only from the webview's own origin with
 * the nonce, styles inline (Fluent's Griffel injects a `<style>` at runtime, which
 * needs `'unsafe-inline'` for style). `'unsafe-eval'` is required: ajv (RJSF's
 * validator) compiles each schema through the `Function` constructor at runtime,
 * and our schemas only EXIST at runtime (they arrive from the live compile), so
 * ajv's build-time standalone precompilation cannot apply. Without it the form
 * renders but every validate call throws — Next never advances. The eval surface
 * is confined to our own nonce-gated local bundle; no remote script can load.
 */
function formPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    // Griffel (Fluent v9) injects styles at runtime; allow inline styles only.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource} 'unsafe-eval'`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDK Form Preview</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
