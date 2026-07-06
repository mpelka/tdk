import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  DRY_RUN_SCHEME,
  DryRunFileProvider,
  openDryRunFile,
  setBackstageBaseUrl,
  setBackstageToken,
} from "./dryRun.ts";
import { registerFormPreview } from "./formPreview.ts";
import { cliNotFoundMessage, resolveTdkBin } from "./lib/resolveCli.ts";
import { TRACE_VIEW_ID, TraceViewProvider } from "./traceView.ts";

/**
 * PATH for spawned processes, augmented with common locations of `bun` (the CLI
 * runs via a `#!/usr/bin/env bun` shebang). VS Code launched from the dock often
 * has a minimal PATH that omits `~/.bun/bin`, so we prepend the usual install
 * dirs — making the installed extension work without launching from a terminal.
 */
function spawnEnv(): NodeJS.ProcessEnv {
  const extra = [
    path.join(os.homedir(), ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
  ];
  const current = process.env.PATH ?? "";
  return { ...process.env, PATH: [...extra, current].filter(Boolean).join(path.delimiter) };
}

/** Captured result of a spawned `tdk` run. `code: -1` marks a spawn that never ran. */
export interface SpawnResult {
  /** The child's exit code, or `-1` when the CLI was not found / never spawned. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The ONE way the extension runs the CLI. Resolves the `tdk` binary through
 * `resolveTdkBin` — the `tdk.cliPath` setting, then the WORKSPACE's own
 * `node_modules/.bin/tdk` (preferred: `@tdk/core` resolves as a single copy, so
 * the DSL's `instanceof` / module-identity checks hold), then PATH, then the
 * `~/.bun/bin/tdk` global link — and spawns it with `cwd` = the workspace
 * folder, capturing stdout/stderr/exit.
 *
 * When NOTHING resolves we DO NOT spawn anything and return `code: -1` with an
 * actionable message naming every searched location. There is deliberately NO
 * `bunx tdk` fallback: the npm registry's `tdk` is an unrelated third-party
 * package, so falling back to it would download and execute a stranger's code
 * with the user's template source piped to its stdin. A binary the user already
 * installed or linked is a different matter — that is theirs to trust.
 *
 * `stdin`, when given, is written to the child's stdin (the editor's possibly
 * UNSAVED buffer for `compile --stdin`). We attach a no-op `error` handler to the
 * stdin stream: if the spawn itself fails, `end(stdin)` would otherwise emit an
 * unhandled `EPIPE`/`ECONNRESET` and crash the extension host.
 */
export function spawnTdk(folder: vscode.WorkspaceFolder, args: string[], stdin?: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const cwd = folder.uri.fsPath;
    const resolved = resolveTdkBin({
      workspaceRoot: cwd,
      cliPathSetting: vscode.workspace.getConfiguration("tdk").get<string>("cliPath") || undefined,
      // The same augmented PATH the child gets — so resolution and execution agree.
      pathDirs: (spawnEnv().PATH ?? "").split(path.delimiter),
      home: os.homedir(),
      exists: fs.existsSync,
    });
    if (!resolved) {
      resolve({ code: -1, stdout: "", stderr: cliNotFoundMessage(cwd) });
      return;
    }
    const bin = resolved.bin;

    const child = cp.spawn(bin, args, { cwd, env: spawnEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => resolve({ code: -1, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) {
      // A failed spawn makes `end()` emit a stream error — swallow it so it never
      // becomes an uncaught exception in the extension host (the `error`/`close`
      // handlers above already resolve the promise).
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}

// TDK VS Code extension — live compile preview (stage A).
//
// `TDK: Compile Preview` takes the active `.ts` template, shells out to the
// workspace's `tdk compile --stdin` CLI (piping the editor's current buffer),
// and shows the compiled Backstage YAML in a read-only panel beside the source.
// The same preview document is reused and recompiles LIVE as you type
// (debounced) — the unsaved buffer, so you see changes before saving.
//
// Errors are NON-DESTRUCTIVE: a failed compile keeps the last good YAML on
// screen (a transient error never wipes the preview) and surfaces instead as a
// diagnostic in the Problems panel + a quiet status-bar indicator. `tdk compile`
// schema-validates by default, so a compile "failure" now includes Backstage
// SCHEMA errors, not just build/transpile ones — both land the same way.
//
// We deliberately run the compile by spawning the WORKSPACE's `tdk` (cwd = the
// template's workspace folder) rather than importing `@tdk/core` here: that
// keeps a single `@tdk/core` copy resolving from the workspace, so the DSL's
// `instanceof`/module-identity checks hold. The extension never bundles core.
// Every spawn goes through `spawnTdk` — the single place bin-resolution, the
// stdin-error guard, and the "CLI not found" failure live (see its docstring).

/** Custom scheme for the read-only compiled-YAML documents. */
const SCHEME = "tdk-preview";
/** Debounce window for live (keystroke-triggered) recompiles. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Serves the compiled YAML for each preview URI. Registering a content provider
 * makes the documents read-only (there is no way to save back to the scheme),
 * and `onDidChange` lets us refresh an already-open preview in place.
 */
class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** Store content for a preview URI and notify any open document to refresh. */
  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  /** Whether a preview URI already has content (i.e. a previous good compile). */
  has(uri: vscode.Uri): boolean {
    return this.contents.has(uri.toString());
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.contents.clear();
  }
}

const provider = new PreviewContentProvider();
/** Source file fsPaths that currently have a live preview (refreshed as you type). */
const previewedSources = new Set<string>();
/** Per-source debounce timers for typing-driven refreshes. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Compile failures surface here (Problems panel + a squiggle), not in the preview. */
const diagnostics = vscode.languages.createDiagnosticCollection("tdk");
/** A quiet status-bar indicator shown while a preview is live (ok / failed). */
let status: vscode.StatusBarItem | undefined;
/** Per-source: did the last compile fail? Drives a once-per-transition toast. */
const lastError = new Map<string, boolean>();

export function activate(context: vscode.ExtensionContext): void {
  const compilePreview = vscode.commands.registerCommand("tdk.compilePreview", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage("TDK: open a .ts template first.");
      return;
    }
    const source = editor.document;
    if (source.languageId !== "typescript" && !source.fileName.endsWith(".ts")) {
      vscode.window.showErrorMessage("TDK: the active editor must be a .ts template.");
      return;
    }
    previewedSources.add(source.uri.fsPath);
    await renderPreview(source, /* reveal */ true);
  });

  // The TDK Trace panel view — a WebviewViewProvider in the PANEL area (a "TDK
  // Trace" tab beside Test Results). The form preview streams each live execute()
  // run here (debugger-style master-detail: a step rail + per-step inputs with
  // provenance, output, and context), instead of embedding the trace in the form.
  // Registered before the form preview so the previews can post to it.
  const traceView = new TraceViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TRACE_VIEW_ID, traceView, {
      // Keep the React trace app alive when the panel tab is hidden — otherwise every
      // tab switch re-mounts it and loses the current selection.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Backstage dry-run (issue #3, phase 3). An emitted-file virtual-document provider
  // (the `tdk-dryrun` read-only scheme), the trace view's file-open handler wired to it,
  // and the set-token + set-base-URL commands. The submit flow itself lives with the form
  // preview (it owns the compile pipeline); this registers the surrounding plumbing.
  const dryRunFiles = new DryRunFileProvider();
  traceView.setOpenFileHandler((filePath, content) => void openDryRunFile(dryRunFiles, filePath, content));
  const setToken = vscode.commands.registerCommand("tdk.backstage.setToken", () => setBackstageToken(context));
  const setBaseUrl = vscode.commands.registerCommand("tdk.backstage.setBaseUrl", () => setBackstageBaseUrl());
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DRY_RUN_SCHEME, dryRunFiles),
    setToken,
    setBaseUrl,
  );

  // Stage C — the form preview (issue #3). `TDK: Open Form Preview` opens a webview
  // beside the template that renders its compiled PARAMETER FORM (RJSF + Fluent),
  // live-recompiling as you edit. Behavioral fidelity only — the right
  // fields/pages/validation/payload, not a Backstage skin. Self-contained in
  // `formPreview.ts`; it reuses this file's `spawnTdk` for the compile and streams
  // its live trace to the TDK Trace view above.
  registerFormPreview(context, traceView);

  // Stage B — the native Test Explorer (the `vscode.tests` Testing API). A
  // workspace-wide TestController surfaces every TESTABLE template (a directory
  // with BOTH `template.ts` and `__fixtures__/scenarios.ts`) as a SUITE in VS Code's
  // native Testing view, with each scenario as a test under it. Running a suite
  // shells out to `tdk execute --json <file>` and reports pass + a per-step trace
  // (see the stage B section below). This REPLACES the old custom Activity-Bar
  // tree.
  const controller = vscode.tests.createTestController("tdkScenarios", "TDK Scenarios");
  controller.resolveHandler = async (item) => {
    if (!item) await discoverTemplates(controller);
    else await resolveSuite(controller, item);
  };
  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    (request, token) => runScenarios(controller, request, token, /* update */ false),
    true,
  );
  // A second profile that ACCEPTS snapshot changes: same as Run, but invokes
  // `tdk test --json -u` so a mismatch is written as the new baseline (and the
  // scenario reported passed). Lets users accept changes from the Test Explorer.
  controller.createRunProfile(
    "Update Snapshots",
    vscode.TestRunProfileKind.Run,
    (request, token) => runScenarios(controller, request, token, /* update */ true),
    false,
  );
  // Populate the suites now — workspace-wide, no active-editor dependency.
  void discoverTemplates(controller);

  // Re-discover / refresh suites when a template or its scenarios.ts changes
  // (debounced; discovery only — runs stay user-initiated).
  const watcher = vscode.workspace.createFileSystemWatcher("**/{template.ts,__fixtures__/scenarios.ts}");
  watcher.onDidChange((uri) => scheduleSuiteRefresh(controller, uri));
  watcher.onDidCreate(() => scheduleDiscovery(controller));
  watcher.onDidDelete(() => scheduleDiscovery(controller));

  // Recompile live as you type — only for sources with a preview, debounced.
  const onChange = vscode.workspace.onDidChangeTextDocument((e) => {
    if (previewedSources.has(e.document.uri.fsPath)) scheduleRefresh(e.document);
  });

  // Stop tracking a source once the user closes its preview tab; clear its
  // diagnostics, and hide the status indicator once no previews remain.
  const onClose = vscode.workspace.onDidCloseTextDocument((closed) => {
    if (closed.uri.scheme !== SCHEME) return;
    const sourcePath = sourcePathFromPreview(closed.uri);
    if (sourcePath) {
      previewedSources.delete(sourcePath);
      lastError.delete(sourcePath);
    }
    const sourceUri = sourceUriFromPreview(closed.uri);
    if (sourceUri) diagnostics.delete(sourceUri);
    if (previewedSources.size === 0) status?.hide();
  });

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "workbench.actions.view.problems";

  context.subscriptions.push(
    compilePreview,
    controller,
    watcher,
    onChange,
    onClose,
    provider,
    diagnostics,
    status,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
  );
}

export function deactivate(): void {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
  previewedSources.clear();
  lastError.clear();
  diagnostics.clear();
  status?.hide();
  // Tear down Stage B's discovery/refresh debounce timers (the controller +
  // watcher themselves are disposed via `context.subscriptions`).
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = undefined;
  for (const timer of suiteRefreshTimers.values()) clearTimeout(timer);
  suiteRefreshTimers.clear();
}

/** Debounce a live recompile per source file (one timer per source). */
function scheduleRefresh(source: vscode.TextDocument): void {
  const key = source.uri.fsPath;
  const existing = refreshTimers.get(key);
  if (existing) clearTimeout(existing);
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      // Update the existing preview in place (no re-reveal while typing).
      void renderPreview(source, /* reveal */ false);
    }, REFRESH_DEBOUNCE_MS),
  );
}

/**
 * Compile `source` via the workspace `tdk compile` CLI and write the result
 * into its (reused) preview document. `reveal` opens/focuses the panel beside
 * the source — true for the explicit command, false for typing-driven refreshes.
 */
async function renderPreview(source: vscode.TextDocument, reveal: boolean): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(source.uri);
  if (!folder) {
    vscode.window.showErrorMessage("TDK: the template must live inside an open workspace folder.");
    return;
  }

  // `tdk compile --stdin <file>`: pipe the (possibly unsaved) buffer so the
  // preview reflects in-flight edits. Compile schema-validates by default, so a
  // non-zero exit can be a build/transpile OR a Backstage schema error — both
  // arrive on stderr as `file:line:col: message` and surface identically.
  const { code, stdout, stderr } = await spawnTdk(folder, ["compile", "--stdin", source.uri.fsPath], source.getText());
  const previewUri = previewUriFor(source.uri);

  if (code === 0) {
    provider.set(previewUri, stdout);
    diagnostics.delete(source.uri);
    lastError.set(source.uri.fsPath, false);
    setStatus(true);
  } else {
    // Sticky: keep the last good YAML on screen — a transient compile error must
    // never wipe the preview. The failure surfaces in the Problems panel (+ the
    // status indicator). Seed a placeholder only when nothing has ever compiled.
    if (!provider.has(previewUri)) {
      provider.set(previewUri, "# TDK: no successful compile yet — see the Problems panel.\n");
    }
    // `code: -1` means the CLI was not found (or the spawn itself failed) — a
    // config problem, not a template error, so it gets its own explicit message
    // rather than being parsed for a (nonexistent) `file:line:col` squiggle.
    const notFound = code === -1;
    const message = stderr.trim() || `tdk compile exited with code ${code}.`;
    reportDiagnostic(source, message);
    setStatus(false, notFound);
    // A toast is a useful "something broke" signal when the Problems panel isn't
    // open — but only when ENTERING the error state (good→bad) or on an explicit
    // invoke. Repeated failing saves while already broken stay quiet.
    const wasError = lastError.get(source.uri.fsPath) === true;
    lastError.set(source.uri.fsPath, true);
    if (!wasError || reveal) {
      vscode.window.showErrorMessage(notFound ? `TDK: ${message}` : "TDK: compile failed — see the Problems panel.");
    }
  }

  if (reveal) {
    const doc = await vscode.workspace.openTextDocument(previewUri);
    await vscode.languages.setTextDocumentLanguage(doc, "yaml");
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
      preview: false,
    });
  }
}

/**
 * The preview URI for a source file. The source URI rides in the query so each
 * source maps to its own reusable preview document (and we can map back on
 * close); the parent dir is kept in the path so VS Code disambiguates the many
 * identically-named `template.ts` tabs.
 */
function previewUriFor(source: vscode.Uri): vscode.Uri {
  const parent = path.basename(path.dirname(source.fsPath));
  const base = path.basename(source.fsPath);
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${parent}/${base}.yaml`,
    query: source.toString(),
  });
}

/** Recover the source file path stashed in a preview URI's query. */
function sourcePathFromPreview(uri: vscode.Uri): string | undefined {
  if (!uri.query) return undefined;
  try {
    return vscode.Uri.parse(uri.query).fsPath;
  } catch {
    return undefined;
  }
}

/**
 * Update the quiet status-bar indicator for the latest compile result. `notFound`
 * (the CLI is missing) gets its own text/tooltip so the status bar names the fix
 * (`bun install`) rather than implying the template is at fault.
 */
function setStatus(ok: boolean, notFound = false): void {
  if (!status) return;
  if (ok) {
    status.text = "$(check) TDK";
    status.tooltip = "TDK compile preview is up to date";
  } else if (notFound) {
    status.text = "$(error) TDK: CLI not found";
    status.tooltip =
      "TDK CLI not found — install @tdk/cli in the workspace, link it globally, or set tdk.cliPath (click for details)";
  } else {
    status.text = "$(error) TDK: compile failed";
    status.tooltip = "TDK: template failed to compile — click to open the Problems panel";
  }
  status.show();
}

/**
 * Publish a compile failure to the Problems panel as a diagnostic on the source
 * file (best-effort squiggle position parsed from the CLI's error text).
 */
function reportDiagnostic(source: vscode.TextDocument, message: string): void {
  const diagnostic = new vscode.Diagnostic(locateError(message, source), message, vscode.DiagnosticSeverity.Error);
  diagnostic.source = "tdk";
  diagnostics.set(source.uri, [diagnostic]);
}

/**
 * Best-effort error range: parse a `<thisFile>:<line>:<col>` location out of the
 * error text (build / transpile / schema errors carry one); otherwise underline
 * line 1 so there is always a visible squiggle to click through to.
 *
 * The CLI emits BOTH `line` and `col` 1-based (it passes Bun's 1-based position
 * straight through — an earlier off-by-one that added +1 to the column has been
 * removed). VS Code's `Range` is 0-based on both axes, so we subtract 1 from each.
 */
function locateError(message: string, source: vscode.TextDocument): vscode.Range {
  const escaped = source.uri.fsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = message.match(new RegExp(`${escaped}:(\\d+):(\\d+)`));
  if (m) {
    const line = Math.max(0, parseInt(m[1]!, 10) - 1);
    const col = Math.max(0, parseInt(m[2]!, 10) - 1);
    const safeLine = Math.min(line, Math.max(0, source.lineCount - 1));
    const text = source.lineAt(safeLine).text;
    return new vscode.Range(safeLine, col, safeLine, Math.max(col + 1, text.length));
  }
  const firstLen = source.lineCount > 0 ? source.lineAt(0).text.length : 1;
  return new vscode.Range(0, 0, 0, Math.max(1, firstLen));
}

/** The source-file Uri stashed in a preview URI's query. */
function sourceUriFromPreview(uri: vscode.Uri): vscode.Uri | undefined {
  if (!uri.query) return undefined;
  try {
    return vscode.Uri.parse(uri.query);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Stage B — the native Test Explorer (the `vscode.tests` Testing API).
//
// A workspace-wide TestController, "TDK Scenarios", surfaces every TESTABLE
// template (a directory holding BOTH `template.ts` and `__fixtures__/scenarios.ts`)
// as a SUITE in VS Code's native Testing view (the beaker icon), with each
// scenario as one test under it. Discovery is workspace-wide and INDEPENDENT of
// the active editor: it runs on activate, via `controller.resolveHandler`, and
// whenever a `template.ts` / `__fixtures__/scenarios.ts` is added/changed/removed
// (a `FileSystemWatcher`, debounced — discovery only, never per-keystroke).
//
// DISCOVERY shells out to `tdk test --list <file>` — a side-effect-free listing
// of templates + their scenario names + `branches[]` (which ride along as
// `TestTag`s). `--list` NEVER executes a scenario or touches snapshots, so it is
// cheap to run on every watched change. RUNNING a suite shells out to
// `tdk test --json <file>` (the file ON DISK — runs are user-initiated): each
// scenario's compiled `ExecuteResult` is snapshot-tested against
// `__snapshots__/scenarios.snap`, and its STATUS drives the test state —
// `passed`/`written`/`updated` → passed, `failed` → failed. A genuine snapshot
// MISMATCH failure carries `expected`+`actual` and renders as VS Code's NATIVE
// diff; a scenario whose `execute()` THREW carries `error` (no diff) and renders
// as a plain failed-test message. The "Update Snapshots" run profile re-runs with
// `-u` to accept changes. A suite-level load/compile failure (`ok:false`, with an
// `error`) fails every scenario — or the suite itself; a per-step trace is
// appended to the run output either way.
// ---------------------------------------------------------------------------

/** Debounce window for watcher-driven discovery / suite refreshes. */
const DISCOVERY_DEBOUNCE_MS = 400;

// --- The `tdk test --list` result shape (a mirror; we never import core). ------

/** One template's `--list` entry: its scenario names + branches, or a load error. */
interface ListedTemplate {
  path: string;
  ok: boolean;
  /** The formatted load error when `ok` is false (`scenarios` is then empty). */
  error?: string;
  scenarios: Array<{ name: string; branches?: string[] }>;
}

/** The parsed outcome of one `tdk test --list` run, or a spawn/parse failure. */
type ListOutcome = { ok: true; template: ListedTemplate } | { ok: false; error: string };

// --- The `tdk test --json` report shape (a mirror; we never import core). ------

/** One step's simulated outcome (RESOLVED `input`/`output`, jsonata `error`). */
interface StepResult {
  skipped?: boolean;
  input: unknown;
  output: unknown;
  error?: string;
}

/** One scenario's simulated run: its steps (keyed, in order) + final output. */
interface ExecuteResultData {
  steps: Record<string, StepResult>;
  output: unknown;
}

/** A scenario's snapshot status on a `tdk test` run. */
type ScenarioStatus = "passed" | "failed" | "written" | "updated";

/** One scenario's snapshot outcome: its status, run trace, and (on a `failed`) diff/error. */
interface TestScenario {
  name?: string;
  branches?: string[];
  status: ScenarioStatus;
  /** The run's `ExecuteResult` (present whenever `execute()` ran) — for the trace. */
  result?: ExecuteResultData;
  /** The stored snapshot YAML — only on a genuine snapshot MISMATCH (native diff). */
  expected?: string;
  /** The fresh result YAML — on a mismatch (native diff); also mirrors `error` for
   *  one release when a scenario THREW (older callers read the message here). */
  actual?: string;
  /** The error text when this scenario's `execute()` THREW — the reliable signal
   *  that a `failed` is a run error (no diff), not a snapshot mismatch. */
  error?: string;
}

/** One template's `tdk test` report: `ok:false` is a load/compile error for the suite. */
interface TestReport {
  path: string;
  ok: boolean;
  error?: string;
  scenarios: TestScenario[];
  obsolete?: string[];
}

// --- Discovery -------------------------------------------------------------

/** Debounce timer for watcher-driven full re-discovery (create/delete). */
let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
/** Per-suite debounce timers for watcher-driven child refreshes (change). */
const suiteRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Populate `controller.items` with one SUITE per testable template across the
 * whole workspace: every `**​/__fixtures__/scenarios.ts` (excluding `node_modules`)
 * whose sibling `../template.ts` exists. Suites are keyed by the template's
 * fsPath, so this reconciles (adds new, drops gone) on every call. Children (the
 * scenarios) resolve lazily via `resolveHandler` / when a suite is run.
 */
async function discoverTemplates(controller: vscode.TestController): Promise<void> {
  const files = await vscode.workspace.findFiles("**/__fixtures__/scenarios.ts", "**/node_modules/**");
  const seen = new Set<string>();
  for (const scenariosUri of files) {
    // <dir>/__fixtures__/scenarios.ts → <dir>/template.ts
    const templatePath = path.join(path.dirname(path.dirname(scenariosUri.fsPath)), "template.ts");
    if (!fs.existsSync(templatePath)) continue;
    seen.add(templatePath);
    upsertSuite(controller, vscode.Uri.file(templatePath));
  }
  // Drop suites whose template is no longer testable.
  const stale: string[] = [];
  controller.items.forEach((item) => {
    if (!seen.has(item.id)) stale.push(item.id);
  });
  for (const id of stale) controller.items.delete(id);
}

/** Create (or return) the suite TestItem for a template; id = its fsPath. */
function upsertSuite(controller: vscode.TestController, templateUri: vscode.Uri): vscode.TestItem {
  const id = templateUri.fsPath;
  let suite = controller.items.get(id);
  if (!suite) {
    suite = controller.createTestItem(id, suiteLabel(templateUri), templateUri);
    suite.canResolveChildren = true;
    controller.items.add(suite);
  }
  return suite;
}

/** A readable suite label: the template's containing directory name (concise — the
 *  full path would eat sidebar real estate; the TestItem id stays the full fsPath). */
function suiteLabel(templateUri: vscode.Uri): string {
  return path.basename(path.dirname(templateUri.fsPath));
}

/**
 * Resolve a suite's children = its scenarios, by running `tdk test --list`
 * (side-effect-free — it neither compiles/runs a scenario nor touches snapshots)
 * for the scenario names + their `branches`. A spawn/parse failure — or a
 * `--list` entry that couldn't LOAD its scenarios (`ok:false`) — leaves any
 * existing children in place (sticky — like the compile preview) so a transient
 * error doesn't blank the suite; running it will report the failure with its
 * diff/error.
 */
async function resolveSuite(controller: vscode.TestController, suite: vscode.TestItem): Promise<void> {
  if (!suite.uri) return;
  const folder = vscode.workspace.getWorkspaceFolder(suite.uri);
  if (!folder) return;
  const outcome = await runList(folder, suite.uri.fsPath);
  if (outcome.ok && outcome.template.ok) reconcileScenarios(controller, suite, outcome.template.scenarios);
}

/**
 * Reconcile a suite's scenario children against a fresh `execute` outcome —
 * stable ids (`<template>::<name>`) preserve identity across refreshes, and each
 * scenario's `branches[]` attach as `TestTag`s.
 */
function reconcileScenarios(
  controller: vscode.TestController,
  suite: vscode.TestItem,
  scenarios: Array<{ name?: string; branches?: string[] }>,
): void {
  const desired = new Map<string, { label: string; branches?: string[] }>();
  scenarios.forEach((s, i) => {
    const label = s.name ?? `scenario ${i + 1}`;
    desired.set(scenarioId(suite, label), { label, branches: s.branches });
  });

  const stale: string[] = [];
  suite.children.forEach((child) => {
    if (!desired.has(child.id)) stale.push(child.id);
  });
  for (const id of stale) suite.children.delete(id);

  for (const [id, { label, branches }] of desired) {
    let child = suite.children.get(id);
    if (!child) {
      child = controller.createTestItem(id, label, suite.uri);
      suite.children.add(child);
    }
    child.label = label;
    child.tags = (branches ?? []).map((b) => new vscode.TestTag(b));
  }
}

/** Stable id for a scenario item under a suite. */
function scenarioId(suite: vscode.TestItem, name: string): string {
  return `${suite.id}::${name}`;
}

/** Debounce a full re-discovery (watcher create/delete). */
function scheduleDiscovery(controller: vscode.TestController): void {
  if (discoveryTimer) clearTimeout(discoveryTimer);
  discoveryTimer = setTimeout(() => {
    discoveryTimer = undefined;
    void discoverTemplates(controller);
  }, DISCOVERY_DEBOUNCE_MS);
}

/**
 * Debounce a refresh of the ONE suite a changed file belongs to (a `template.ts`
 * or its `__fixtures__/scenarios.ts`). Falls back to full discovery if that suite
 * isn't known yet (e.g. a template just became testable).
 */
function scheduleSuiteRefresh(controller: vscode.TestController, uri: vscode.Uri): void {
  const suiteId = suiteIdForFile(uri.fsPath);
  const existing = suiteRefreshTimers.get(suiteId);
  if (existing) clearTimeout(existing);
  suiteRefreshTimers.set(
    suiteId,
    setTimeout(() => {
      suiteRefreshTimers.delete(suiteId);
      const suite = controller.items.get(suiteId);
      if (suite) void resolveSuite(controller, suite);
      else void discoverTemplates(controller);
    }, DISCOVERY_DEBOUNCE_MS),
  );
}

/** The suite id (template fsPath) a watched file belongs to. */
function suiteIdForFile(fsPath: string): string {
  const unix = fsPath.split(path.sep).join("/");
  if (unix.endsWith("/__fixtures__/scenarios.ts")) {
    return path.join(path.dirname(path.dirname(fsPath)), "template.ts");
  }
  return fsPath; // a template.ts
}

// --- Running ---------------------------------------------------------------

/** Which scenarios of a suite a run requested: every one, or a specific set. */
type Requested = "all" | Set<string>;

/**
 * The run-profile handler. Resolves the request into a per-suite plan, then runs
 * each suite's `tdk test --json` once — marking its scenarios from the snapshot
 * status + appending a per-step trace. `update` selects the "Update Snapshots"
 * profile (`tdk test --json -u`, accepting any change). Always `run.end()`s.
 */
async function runScenarios(
  controller: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  update: boolean,
): Promise<void> {
  const run = controller.createTestRun(request);
  try {
    for (const [suiteId, requested] of planRun(controller, request)) {
      if (token.isCancellationRequested) break;
      const suite = controller.items.get(suiteId);
      if (suite) await runSuite(controller, run, suite, requested, token, update);
    }
  } finally {
    run.end();
  }
}

/** Build the per-suite run plan from a request's include/exclude. */
function planRun(controller: vscode.TestController, request: vscode.TestRunRequest): Map<string, Requested> {
  const plan = new Map<string, Requested>();
  const addScenario = (suite: vscode.TestItem, id: string) => {
    const cur = plan.get(suite.id);
    if (cur === "all") return;
    const set = cur ?? new Set<string>();
    set.add(id);
    plan.set(suite.id, set);
  };

  if (request.include?.length) {
    for (const item of request.include) {
      if (item.parent) addScenario(item.parent, item.id);
      else plan.set(item.id, "all");
    }
  } else {
    controller.items.forEach((suite) => {
      plan.set(suite.id, "all");
    });
  }

  for (const ex of request.exclude ?? []) {
    if (!ex.parent) {
      plan.delete(ex.id);
      continue;
    }
    const cur = plan.get(ex.parent.id);
    if (cur instanceof Set) cur.delete(ex.id);
    else if (cur === "all") {
      // Expand "all" to an explicit set minus the excluded scenario.
      const set = new Set<string>();
      ex.parent.children.forEach((c) => {
        if (c.id !== ex.id) set.add(c.id);
      });
      plan.set(ex.parent.id, set);
    }
  }
  return plan;
}

/**
 * Run ONE suite: `tdk test --json [-u] <template>` (disk), then per scenario map
 * its SNAPSHOT status to a test state:
 *   - `passed`            → `run.passed`
 *   - `written`/`updated` → `run.passed` (snapshot just created/accepted)
 *   - `failed`            → `run.failed`; a genuine snapshot MISMATCH (`expected`
 *      set, no `error`) carries `expectedOutput`/`actualOutput` so VS Code renders
 *      its native diff; a scenario that THREW (`error` set) renders as a plain
 *      failed-test message with the error text — no misleading diff. A per-step
 *      trace is appended either way.
 * A suite-level load/compile failure (`ok:false` — a bad import, compile error,
 * broken/export-less scenarios file, duplicate scenario names, or corrupt
 * snapshot) fails every (requested) scenario — or the suite itself if no children
 * are known yet — with the formatted error, even when `scenarios` came back empty.
 */
async function runSuite(
  controller: vscode.TestController,
  run: vscode.TestRun,
  suite: vscode.TestItem,
  requested: Requested,
  token: vscode.CancellationToken,
  update: boolean,
): Promise<void> {
  if (!suite.uri) return;
  const folder = vscode.workspace.getWorkspaceFolder(suite.uri);
  if (!folder) return;

  const started = Date.now();
  const report = await runTest(folder, suite.uri.fsPath, update);
  const elapsed = Date.now() - started;
  if (token.isCancellationRequested) return;

  if (!report.ok) {
    // A suite-level failure (bad import / compile error / broken or export-less
    // scenarios file / duplicate names / corrupt snapshot). The report may carry
    // scenario NAMES (all `failed`) or an empty array — reconcile to whatever
    // names we got so the failure attaches to the right children, then fail the
    // requested targets (or the suite itself when there are none).
    if (report.scenarios.length) reconcileScenarios(controller, suite, report.scenarios);
    const error = report.error ?? "template error";
    const message = new vscode.TestMessage(error);
    for (const item of failTargets(suite, requested)) {
      run.started(item);
      run.failed(item, message, elapsed);
    }
    run.appendOutput(templateErrorTrace(suite, error), undefined, suite);
    return;
  }

  reconcileScenarios(controller, suite, report.scenarios);
  const per = report.scenarios.length ? Math.round(elapsed / report.scenarios.length) : elapsed;
  for (let i = 0; i < report.scenarios.length; i++) {
    const s = report.scenarios[i]!;
    const id = scenarioId(suite, s.name ?? `scenario ${i + 1}`);
    const item = suite.children.get(id);
    if (!item) continue;
    if (requested !== "all" && !requested.has(id)) continue;
    run.enqueued(item);
    run.started(item);
    run.appendOutput(scenarioTrace(s), undefined, item);

    if (s.status === "failed") {
      // Discriminate on `error`, the reliable per-scenario signal: an `execute()`
      // that THREW sets `error` (and mirrors it into `actual`) but never
      // `expected`. Show it as a plain failed-test message — a native diff there
      // would be a lie ("expected vs actual" when nothing was compared). A genuine
      // snapshot MISMATCH sets `expected` (possibly "" for a missing snapshot
      // under --ci) and `actual` → VS Code's native diff.
      let message: vscode.TestMessage;
      if (s.error !== undefined) {
        message = new vscode.TestMessage(s.error);
      } else if (s.expected !== undefined) {
        message = new vscode.TestMessage("Snapshot mismatch — the compiled output changed.");
        message.expectedOutput = s.expected;
        if (s.actual !== undefined) message.actualOutput = s.actual;
      } else {
        // No error text and no diff — a `failed` we can't characterize (shouldn't
        // happen with the current CLI); fail loudly rather than silently pass.
        message = new vscode.TestMessage(s.actual ?? "Scenario failed.");
      }
      run.failed(item, message, per);
    } else {
      run.passed(item, per);
    }
  }
}

/** Items to mark failed for a template-level error: requested scenarios, or the suite. */
function failTargets(suite: vscode.TestItem, requested: Requested): vscode.TestItem[] {
  const children: vscode.TestItem[] = [];
  suite.children.forEach((c) => {
    if (requested === "all" || requested.has(c.id)) children.push(c);
  });
  return children.length ? children : [suite];
}

// --- Run output (the vitest-style per-step trace) --------------------------

/** `appendOutput` renders in a terminal — it needs CRLF line endings. */
const NL = "\r\n";

/**
 * A readable, vitest-style trace of one scenario: its snapshot `status`, then —
 * when `execute()` ran — its per-step trace + final output. A scenario that THREW
 * has no `result`; show its `error` (falling back to the `actual` mirror). The
 * expected/actual diff of a genuine snapshot mismatch rides on the `TestMessage`
 * (VS Code's native diff), not here.
 */
function scenarioTrace(s: TestScenario): string {
  const lines: string[] = [`▶ ${s.name ?? "(unnamed scenario)"} [${s.status}]`];
  if (s.result) {
    for (const [id, step] of Object.entries(s.result.steps)) {
      lines.push(`  • ${id} ${stepMarker(step)}`);
      pushJson(lines, "input", step.input);
      pushJson(lines, "output", step.output);
    }
    pushJson(lines, "output", s.result.output, "  ");
  } else {
    const errored = s.error ?? s.actual;
    if (errored) for (const ln of errored.split("\n")) lines.push(`  ✗ ${ln}`);
  }
  return lines.join(NL) + NL + NL;
}

/** A single template-error block for the run output. */
function templateErrorTrace(suite: vscode.TestItem, error: string): string {
  const lines = [`✗ ${suite.label} — template error`];
  for (const ln of error.split("\n")) lines.push(`  ${ln}`);
  return lines.join(NL) + NL + NL;
}

/** A step's `[ran]` / `[skipped]` / `[errored: …]` marker. */
function stepMarker(step: StepResult): string {
  if (typeof step.error === "string") return `[errored: ${step.error}]`;
  if (step.skipped) return "[skipped]";
  return "[ran]";
}

/** Push a labeled, pretty-printed JSON block into a CRLF trace (indented). */
function pushJson(lines: string[], label: string, value: unknown, indent = "    "): void {
  lines.push(`${indent}${label}:`);
  const json = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
  for (const ln of (json ?? "undefined").split("\n")) lines.push(`${indent}  ${ln}`);
}

// --- Spawning `tdk test --list` (discovery — no execution, no snapshot IO) ---

/**
 * Run `tdk test --list <file>` (the file ON DISK) and parse stdout into the
 * data-only `ListOutcome`. `--list` is SIDE-EFFECT-FREE — it neither runs a
 * scenario nor touches snapshots — so it is safe to call on every watched change.
 * The CLI exits 1 (but still prints JSON) when a listed template's scenarios file
 * fails to LOAD; we surface that as `template.ok:false` (the caller leaves the
 * suite's children in place). Only a spawn failure (CLI not found → `code: -1`) or
 * unparseable stdout is a hard `ok:false` outcome.
 */
async function runList(folder: vscode.WorkspaceFolder, filePath: string): Promise<ListOutcome> {
  const { code, stdout, stderr } = await spawnTdk(folder, ["test", "--list", filePath]);
  // `code: -1` is the CLI-not-found / spawn-failure sentinel — no JSON to parse.
  if (code === -1) return { ok: false, error: stderr.trim() || "tdk test --list could not be spawned." };
  try {
    const parsed = JSON.parse(stdout) as { templates?: ListedTemplate[] };
    const template = parsed.templates?.[0];
    if (template) return { ok: true, template };
  } catch {
    // fall through — unparseable stdout is a discovery failure
  }
  return { ok: false, error: stderr.trim() || `Could not parse tdk test --list output:\n${stdout.slice(0, 2000)}` };
}

// --- Spawning `tdk test` (snapshot runs) -----------------------------------

/**
 * Run `tdk test --json [-u] <file>` (one template) and parse stdout into its
 * `TestReport`. The CLI exits non-zero when a scenario MISMATCHES but still
 * prints the report — so we parse stdout regardless of exit code, and only treat
 * it as a suite-level error when stdout isn't parseable (a load/compile error,
 * which the CLI writes to stderr + exits 1) or the CLI wasn't found (`code: -1`).
 * `update` passes `-u` (accept). Everything routes through `spawnTdk`, so a
 * missing CLI surfaces here as its actionable `bun install` message.
 */
async function runTest(folder: vscode.WorkspaceFolder, filePath: string, update: boolean): Promise<TestReport> {
  const flags = update ? ["test", "--json", "-u"] : ["test", "--json"];
  const { code, stdout, stderr } = await spawnTdk(folder, [...flags, filePath]);
  // Only try to parse when the CLI actually ran (`code: -1` = not found → no JSON).
  if (code !== -1) {
    try {
      const parsed = JSON.parse(stdout) as { templates?: TestReport[] };
      const report = parsed.templates?.[0];
      if (report) return report;
    } catch {
      // fall through — unparseable stdout is a suite-level error
    }
  }
  return {
    path: filePath,
    ok: false,
    error: stderr.trim() || `tdk test exited with code ${code}.`,
    scenarios: [],
  };
}
