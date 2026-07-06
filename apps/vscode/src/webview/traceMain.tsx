// The TDK Trace VIEW webview entry — the second webview bundle. It mounts <TraceApp>
// in the panel-area view the extension registers (a WebviewViewProvider). Same
// theme-tracking FluentProvider setup as the form (via `mountWithFluentTheme`), so
// the trace tracks the editor's color theme identically.
//
// The trace view RECEIVES the execute() runs the extension pushes; the only thing it
// posts back is the `ready` HANDSHAKE — once, after its listener attaches — so the
// provider can replay its buffered latest trace without racing this async mount (the
// same race the form panel has). It wires both `subscribe` and a minimal `post`.

import { mountWithFluentTheme } from "./fluentRoot.tsx";
import type { ExtensionToTraceView, TraceViewToExtension } from "./protocol.ts";
import { TraceApp } from "./TraceApp.tsx";

/** The VS Code webview API, injected once into the view's global scope. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

/** Post a typed message back to the extension host (only the `ready` handshake). */
function post(message: TraceViewToExtension): void {
  vscode.postMessage(message);
}

/** Subscribe to typed trace messages from the extension host. */
function subscribe(handler: (msg: ExtensionToTraceView) => void): void {
  window.addEventListener("message", (event: MessageEvent<ExtensionToTraceView>) => handler(event.data));
}

mountWithFluentTheme(<TraceApp subscribe={subscribe} post={post} />);
