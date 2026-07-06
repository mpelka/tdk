// The Backstage dry-run SUBMIT flow + supporting VS Code plumbing (issue #3, phase 3).
//
// This module owns the extension-host side of "Dry-run in Backstage":
//   1. `setBackstageToken` — the `TDK: Set Backstage Token` command: a password
//      InputBox → `context.secrets`.
//   2. `runDryRun` — the submit orchestration: read the setup (baseUrl setting + token
//      secret), compile the CURRENT env's template (reusing the existing `tdk compile`
//      pipeline via the injected `compile`), parse the YAML into the entity JSON, call
//      the pure `dryRun` client, turn the classified result into a `DryRunTraceMessage`
//      (pure `presentDryRun`), and post it to the TDK Trace view — with a "running…"
//      placeholder while the request is in flight and an info-message path when the
//      setup is incomplete.
//   3. `DryRunFileProvider` — a `TextDocumentContentProvider` for the `tdk-dryrun`
//      scheme that serves each emitted file's decoded content as a READ-ONLY virtual
//      document; `openDryRunFile` opens one.
//
// The pure pieces (the client, the presentation, the grouping, the setup decision) live
// in `lib/` and are unit-tested there; this module is the thin VS Code adapter around
// them, so it stays free of business logic that isn't about VS Code itself.

import * as vscode from "vscode";
import { parse as parseYaml } from "yaml";
import { BACKSTAGE_BASE_URL_KEY, BACKSTAGE_TOKEN_KEY, backstageSetup } from "./lib/backstageConfig.ts";
import { normalizeBaseUrl, validateBaseUrl } from "./lib/baseUrlInput.ts";
import type { SourceStep } from "./lib/buildTrace.ts";
import { dryRun, type FetchLike, type TemplateEntity } from "./lib/dryRunClient.ts";
import { dryRunEndpoint, presentDryRun } from "./lib/dryRunPresentation.ts";
import type { TraceViewProvider } from "./traceView.ts";
import type { DryRunFile } from "./webview/protocol.ts";

/** The virtual-document scheme for emitted dry-run files (read-only, in-memory). */
export const DRY_RUN_SCHEME = "tdk-dryrun";

/**
 * Compile one env of a template to YAML — the seam the submit flow depends on, so it can
 * reuse `formPreview`'s existing compile pipeline (which pipes the dirty buffer through
 * `tdk compile --stdin`) without this module importing that machinery. Returns the
 * compiled YAML, or an error string.
 */
export type CompileForDryRun = () => Promise<{ ok: true; yaml: string } | { ok: false; error: string }>;

/** What `runDryRun` needs about the template + where to render. */
export interface DryRunContext {
  /** The template's display title (for the trace header). */
  title: string;
  /** The form's current values — the parameters payload the server validates. */
  values: Record<string, unknown>;
  /**
   * The compiled `spec.steps[]` — the `${{ … }}` SOURCE side of the dry-run provenance
   * pairing (the extension already parses these for the local trace). Lets the dry-run's
   * per-step inputs render with the SAME expression → value provenance as the local trace.
   */
  sourceSteps: SourceStep[];
  /** Compile the current env's template to YAML (the existing pipeline). */
  compile: CompileForDryRun;
}

/**
 * The `TDK: Set Backstage Token` command: prompt for a token in a PASSWORD InputBox and
 * store it in SecretStorage (never a setting — a token must not land in settings.json).
 * An empty submit CLEARS the stored token (a way to sign out). Cancelling leaves it as-is.
 */
export async function setBackstageToken(context: vscode.ExtensionContext): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "Set Backstage Token",
    prompt:
      "A bearer token for the Backstage dry-run API (stored in VS Code SecretStorage, not settings). Leave empty to clear.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "paste your Backstage token",
  });
  if (token === undefined) return; // cancelled
  if (token.trim() === "") {
    await context.secrets.delete(BACKSTAGE_TOKEN_KEY);
    vscode.window.showInformationMessage("TDK: Backstage token cleared.");
    return;
  }
  await context.secrets.store(BACKSTAGE_TOKEN_KEY, token.trim());
  vscode.window.showInformationMessage("TDK: Backstage token saved.");
}

/**
 * The `TDK: Set Backstage Base URL` command: prompt for the base URL in an InputBox
 * PRE-FILLED with the current setting, validate it live (empty is allowed — it CLEARS the
 * setting = turns the dry-run off; otherwise it must parse as an http/https URL), and
 * write it to the `tdk.backstage.baseUrl` GLOBAL setting. The palette counterpart to
 * `TDK: Set Backstage Token`, so a user never has to hunt through the settings UI. The
 * validation + normalization are the pure `validateBaseUrl` / `normalizeBaseUrl` (unit-
 * tested); this is the thin VS Code adapter. Cancelling leaves the setting untouched.
 */
export async function setBackstageBaseUrl(): Promise<void> {
  const config = vscode.workspace.getConfiguration("tdk");
  const current = config.get<string>(BACKSTAGE_BASE_URL_KEY) ?? "";
  const value = await vscode.window.showInputBox({
    title: "Set Backstage Base URL",
    prompt:
      "The Backstage backend URL for Dry-run in Backstage (e.g. http://localhost:7007). Leave empty to clear and turn the feature off.",
    value: current,
    ignoreFocusOut: true,
    placeHolder: "http://localhost:7007",
    validateInput: validateBaseUrl,
  });
  if (value === undefined) return; // cancelled — leave the setting as-is
  const next = normalizeBaseUrl(value);
  await config.update(BACKSTAGE_BASE_URL_KEY, next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    next === undefined ? "TDK: Backstage base URL cleared." : `TDK: Backstage base URL set to ${next}.`,
  );
}

/**
 * Read the current setup: the `tdk.backstage.baseUrl` setting + the SecretStorage token.
 * Pure decision (`backstageSetup`) so the ready/blocked split is unit-tested.
 */
async function readSetup(context: vscode.ExtensionContext) {
  const baseUrl = vscode.workspace.getConfiguration("tdk").get<string>(BACKSTAGE_BASE_URL_KEY);
  const token = await context.secrets.get(BACKSTAGE_TOKEN_KEY);
  return backstageSetup(baseUrl, token ?? undefined);
}

/**
 * Run the dry-run submit and render the outcome in the TDK Trace view. Steps:
 *   - setup check: a missing baseUrl shows an actionable info message (with a button to
 *     open the setting) and STOPS — no half-run.
 *   - compile the current env's template; a compile failure renders as an error in the
 *     trace view (same surface as everything else) so the user sees WHY without hunting.
 *   - parse the YAML → entity JSON; post a "running…" placeholder; call the client.
 *   - present the classified result and post it. On `authFailed` also raise a toast with
 *     the fix, since the trace view might not be visible.
 *
 * `fetchImpl` is injected (production passes the global `fetch`); the trace view is where
 * every outcome lands.
 */
export async function runDryRun(
  context: vscode.ExtensionContext,
  ctx: DryRunContext,
  traceView: TraceViewProvider,
  fetchImpl: FetchLike,
  post?: (message: Parameters<TraceViewProvider["post"]>[0]) => void,
): Promise<void> {
  // Callers may supply a GUARDED post (the form preview stamps dry-runs into its
  // trace-run sequence so a SLOW dry-run never clobbers a newer local run, and
  // vice versa); bare `traceView.post` is the default for direct callers/tests.
  const emit = post ?? ((message: Parameters<TraceViewProvider["post"]>[0]) => traceView.post(message));
  const setup = await readSetup(context);
  if (!setup.ready) {
    // Offer the dedicated command (a pre-filled, validated InputBox) as the primary fix,
    // and the raw settings UI as a secondary — either way the user lands where they can
    // set the base URL, rather than being told to go find it.
    const SET = "Set Base URL";
    const OPEN = "Open Setting";
    const choice = await vscode.window.showInformationMessage(`TDK: ${setup.reason}`, SET, OPEN);
    if (choice === SET) {
      await vscode.commands.executeCommand("tdk.backstage.setBaseUrl");
    } else if (choice === OPEN) {
      await vscode.commands.executeCommand("workbench.action.openSettings", "tdk.backstage.baseUrl");
    }
    return;
  }

  // A pre-request failure (compile or parse) never contacts Backstage — its slot header
  // says "not sent" so the endpoint line is still present but honest that no round trip
  // happened.
  const notSent = { baseUrl: setup.baseUrl, status: "not sent", durationMs: 0 };

  const compiled = await ctx.compile();
  if (!compiled.ok) {
    emit({
      type: "dryRunResult",
      title: ctx.title,
      kind: "error",
      endpoint: notSent,
      message: `Could not compile the template for the dry-run:\n${compiled.error}`,
    });
    return;
  }

  let template: TemplateEntity;
  try {
    const parsed = parseYaml(compiled.yaml);
    if (typeof parsed !== "object" || parsed === null) throw new Error("compiled YAML is not a template entity");
    template = parsed as TemplateEntity;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({
      type: "dryRunResult",
      title: ctx.title,
      kind: "error",
      endpoint: notSent,
      message: `Could not parse the compiled template: ${message}`,
    });
    return;
  }

  // Immediate feedback: a placeholder while the POST is outstanding (the trace view
  // auto-switches to the dry-run slot on this). Name the endpoint already.
  emit({ type: "dryRunPending", title: ctx.title, baseUrl: setup.baseUrl });

  // Bound the wait: a Backstage that accepts the connection but never responds
  // would otherwise leave the panel on the pending placeholder FOREVER. An abort
  // lands in the client's catch and classifies as `unreachable`.
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), DRY_RUN_TIMEOUT_MS);
  // Measure the round-trip for the slot header's duration — around the fetch itself.
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof dryRun>>;
  try {
    result = await dryRun(
      { baseUrl: setup.baseUrl, token: setup.token, template, values: ctx.values },
      fetchImpl,
      abort.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
  const durationMs = Date.now() - startedAt;
  const endpoint = dryRunEndpoint(result, setup.baseUrl, durationMs);
  const message = presentDryRun(
    result,
    ctx.title,
    endpoint,
    { sourceSteps: ctx.sourceSteps, parameters: ctx.values },
    decodeBase64,
  );
  emit(message);

  // An auth failure is worth a toast too — the trace view may be hidden, and the fix is a
  // command the user needs to find.
  if (result.kind === "authFailed") {
    const SET = "Set Token";
    const choice = await vscode.window.showErrorMessage(`TDK: ${result.message}`, SET);
    if (choice === SET) await vscode.commands.executeCommand("tdk.backstage.setToken");
  }
}

/** How long a dry-run POST may stay outstanding before it aborts → `unreachable`. */
const DRY_RUN_TIMEOUT_MS = 30_000;

/** Decode a base64 string to UTF-8 text using Node's Buffer (extension host is Node). */
function decodeBase64(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * A `TextDocumentContentProvider` for the `tdk-dryrun` scheme: serves each emitted file's
 * decoded content as a read-only virtual document. Content is keyed by the URI string;
 * `openDryRunFile` stashes the content and opens the doc. Registering a provider makes the
 * documents read-only (there is no writable target for the scheme).
 */
export class DryRunFileProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  // Fired on `set()` so an ALREADY-OPEN virtual doc refreshes when a newer run
  // emits the same path — without it, VS Code serves its cached (stale) copy.
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** Stash a file's decoded content under its virtual URI. */
  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }
}

/**
 * The virtual URI for an emitted dry-run file: the file's path rides in the URI path so
 * the editor tab shows a meaningful name (and the language is inferred from the
 * extension), while the scheme keeps it read-only. Distinct paths get distinct URIs.
 */
export function dryRunFileUri(file: Pick<DryRunFile, "path">): vscode.Uri {
  // Normalize to a leading slash so VS Code treats it as an absolute virtual path.
  const p = file.path.startsWith("/") ? file.path : `/${file.path}`;
  return vscode.Uri.from({ scheme: DRY_RUN_SCHEME, path: p });
}

/**
 * Open an emitted dry-run file as a read-only virtual document beside the editor. Stashes
 * the (already-decoded) content into the provider, opens the doc for the file's virtual
 * URI, and shows it. The exec bit rides in the tab title as a badge-ish suffix.
 */
export async function openDryRunFile(provider: DryRunFileProvider, path: string, content: string): Promise<void> {
  const uri = dryRunFileUri({ path });
  provider.set(uri, content);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}
