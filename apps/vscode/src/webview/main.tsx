// The FORM webview entry: acquire the VS Code API, wire the message channel to the
// React <App>, and mount it inside a theme-tracking FluentProvider (shared with the
// trace view via `mountWithFluentTheme`).
//
// MESSAGES. `acquireVsCodeApi()` is injected once by the host; we grab it here and
// hand the app a typed `post` (webview -> extension) plus a `subscribe` that
// forwards `window.message` events (extension -> webview). Both sides share the
// `protocol.ts` types.

import { App } from "./App.tsx";
import { mountWithFluentTheme } from "./fluentRoot.tsx";
import type { ExtensionToWebview, WebviewToExtension } from "./protocol.ts";

/** The VS Code webview API, injected once into the webview global scope. */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

/** Post a typed message back to the extension host. */
function post(message: WebviewToExtension): void {
  vscode.postMessage(message);
}

/** Subscribe to typed messages from the extension host. */
function subscribe(handler: (msg: ExtensionToWebview) => void): void {
  window.addEventListener("message", (event: MessageEvent<ExtensionToWebview>) => handler(event.data));
}

mountWithFluentTheme(<App subscribe={subscribe} post={post} />);
