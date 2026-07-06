// The TDK Trace panel view — a `WebviewViewProvider` for a view in the PANEL area
// (a "TDK Trace" tab beside Test Results). The form preview posts each live
// execute() run here instead of into the form webview, so the trace is a real,
// dockable, closable debugger-style surface the user can drag anywhere or put in a
// third column.
//
// REVEAL POLICY. The view is revealed on the FIRST trace of a session
// (`<viewId>.focus`, once) so a user who has never opened it still sees their first
// run — but never again after that: if they close it, it stays closed (we respect
// that). A trace posted while the view isn't resolved is BUFFERED and flushed when
// the view (re)appears, so nothing is lost to a race.
//
// This module owns only the view plumbing. The extension builds the enriched
// `TraceMessage` (provenance + context) and hands it to `post()`; the message shape
// is the shared protocol type.

import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { ExtensionToTraceView, TraceViewToExtension } from "./webview/protocol.ts";

/** The view id — must match the `contributes.views` entry in package.json. */
export const TRACE_VIEW_ID = "tdkTrace";

/**
 * Serves the TDK Trace webview view and relays trace messages to it. One instance,
 * registered on activate; the form preview calls `post()` with each run.
 */
export class TraceViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** The most recent message, buffered so a view that resolves late still gets it. */
  private pending: ExtensionToTraceView | undefined;
  /** Whether we've auto-revealed the view once this session (reveal-once policy). */
  private revealedOnce = false;
  /**
   * Whether the CURRENT view's React app has posted its `ready` handshake. `resolveWebviewView`
   * only creates the view + wires the HTML — the app inside mounts and subscribes
   * asynchronously AFTER that, so a `pending` flush at resolve time can still race the
   * subscribe and be lost. We flush on `ready` instead. Reset to false on every
   * (re)resolve, since a re-created view has a fresh, not-yet-subscribed app.
   */
  private ready = false;

  /**
   * Handler for an emitted dry-run file click (set by the extension on register). The
   * trace app posts `openDryRunFile` with the path + decoded content; this opens it as a
   * read-only virtual document. Optional so the view still works before it is wired.
   */
  private onOpenFile: ((path: string, content: string) => void) | undefined;

  /**
   * Handler for a ‹ › run-history navigation click (set by the form preview on register).
   * The trace app posts `dryRunNavigate` with a direction; the form preview moves the ACTIVE
   * preview's history selection and replays the selected run through its seq-guarded path.
   * Optional so the view still works before it is wired.
   */
  private onNavigate: ((direction: "prev" | "next") => void) | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Wire the dry-run file-open handler (the extension registers the virtual-doc opener). */
  setOpenFileHandler(handler: (path: string, content: string) => void): void {
    this.onOpenFile = handler;
  }

  /** Wire the run-history navigation handler (the form preview registers it — item #4). */
  setNavigateHandler(handler: (direction: "prev" | "next") => void): void {
    this.onNavigate = handler;
  }

  /**
   * Standard `WebviewViewProvider` hook — VS Code calls it when the view first
   * becomes visible (or after it was closed and reopened). We wire the HTML and listen
   * for the app's `ready` handshake; the buffered trace is flushed on THAT (not here),
   * because the app subscribes only after its async mount — a flush at resolve time
   * would race the subscribe and be dropped.
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = traceViewHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((message: TraceViewToExtension) => {
      // The trace app posts back three things: the `ready` handshake (flush the buffered
      // run), an `openDryRunFile` when the user clicks an emitted file (open it as a
      // read-only virtual document), and a `dryRunNavigate` when the user clicks a ‹ › run-
      // history button (replay the newly-selected run via the wired handler).
      if (message.type === "ready") {
        this.ready = true;
        if (this.pending) void view.webview.postMessage(this.pending);
      } else if (message.type === "openDryRunFile") {
        this.onOpenFile?.(message.path, message.content);
      } else if (message.type === "dryRunNavigate") {
        this.onNavigate?.(message.direction);
      }
    });
    view.onDidDispose(() => {
      // The view was closed/torn down — forget it (and its readiness), but KEEP
      // `pending` so the next resolve→ready flushes the latest run, and KEEP
      // `revealedOnce` so we don't re-force it open (respect the user closing it).
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  /**
   * Post a trace (or clear) to the view. Always buffers it as `pending` so a later
   * resolve→ready replays the latest; posts immediately only when the view is live AND
   * its app has handshaked `ready`. On the FIRST trace of the session, reveals the view
   * once (`focus`) so a user who never opened it still sees their first run — but never
   * forces it open again.
   */
  post(message: ExtensionToTraceView): void {
    // A `dryRunHistoryUpdate` is a PARTIAL refresh of an already-shown result — replaying it
    // ALONE into a re-created view would render nothing. Buffer only FULL states as
    // `pending`; the refresh still posts through live, and the focus-switch replay re-tags
    // the selected run fresh anyway.
    if (message.type !== "dryRunHistoryUpdate") this.pending = message;
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    } else if (!this.view && isRun(message) && !this.revealedOnce) {
      // No view yet and this is a real run (a local trace OR a Backstage dry-run) —
      // reveal it once. `focus` resolves the view; its app then posts `ready`, which
      // flushes `pending`.
      this.revealedOnce = true;
      void vscode.commands.executeCommand(`${TRACE_VIEW_ID}.focus`);
    }
  }

  /** Clear the view to its empty state (the form panel that drove it closed). */
  clear(): void {
    this.post({ type: "traceClear" });
  }
}

/**
 * Whether a message is a REAL run worth auto-revealing the view for the first time — a
 * local execute trace or a Backstage dry-run (result or pending). A `traceClear` is not
 * a run, so it never forces the view open.
 */
function isRun(message: ExtensionToTraceView): boolean {
  return message.type === "trace" || message.type === "dryRunResult" || message.type === "dryRunPending";
}

/**
 * The trace view's HTML: the same strict CSP + per-load nonce the form panel uses,
 * the trace webview bundle (`dist/webview/traceMain.js`) served through
 * `asWebviewUri`, and a `#root` mount. `'unsafe-eval'` is NOT needed here (the trace
 * view runs no ajv), but `'unsafe-inline'` for styles is (Fluent's Griffel injects a
 * `<style>` at runtime). No remote content is allowed.
 */
function traceViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "traceMain.js"));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TDK Trace</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
