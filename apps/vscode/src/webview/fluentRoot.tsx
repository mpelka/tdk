// Shared webview bootstrap for BOTH bundles — the form panel (main.tsx) and the TDK
// Trace view (traceMain.tsx). Factored out so the theme-tracking FluentProvider is
// defined once and reused, exactly as the task requires.
//
// THEME. VS Code sets a class on the webview root — `vscode-light`, `vscode-dark`,
// or `vscode-high-contrast` — and a `data-vscode-theme-kind` attribute. Which
// element carries them (body vs html) and WHEN they land relative to our script has
// varied across versions, so read every signal from both elements and let a
// MutationObserver catch late arrivals (it doubles as the initial-theme correction).
// Fluent v9 styles come from Griffel at runtime — no CSS files to ship.
//
// MESSAGES. `acquireVsCodeApi()` is injected once by the host; each entry grabs it
// and builds a typed `subscribe` over `window.message`. This module is theme-only —
// message wiring stays in each entry so the two bundles keep their own protocol
// types.

import { FluentProvider, type Theme, webDarkTheme, webLightTheme } from "@fluentui/react-components";
import * as React from "react";
import { createRoot } from "react-dom/client";

/**
 * Map VS Code's theme signals to a Fluent theme. Reads the class + theme-kind from
 * both `body` and `documentElement` because which one carries them varies by version.
 */
export function fluentThemeFromDocument(): Theme {
  const signals = [
    document.body.className,
    document.documentElement.className,
    document.body.dataset.vscodeThemeKind ?? "",
    document.documentElement.dataset.vscodeThemeKind ?? "",
  ].join(" ");
  return signals.includes("vscode-dark") || signals.includes("vscode-high-contrast") ? webDarkTheme : webLightTheme;
}

/**
 * Mount `children` inside a FluentProvider that tracks VS Code's color theme, into
 * the element with id `root`. Shared by both webview entries. A no-op if the mount
 * point is absent (should never be — the host HTML always ships a `#root`).
 */
export function mountWithFluentTheme(children: React.ReactNode): void {
  function Root(): React.ReactElement {
    const [theme, setTheme] = React.useState<Theme>(fluentThemeFromDocument);
    React.useEffect(() => {
      // The host swaps the theme class/attribute when the color theme changes — and
      // may apply it only AFTER our script ran, so this observer doubles as the
      // late-arrival correction for the initial theme.
      const observer = new MutationObserver(() => setTheme(fluentThemeFromDocument()));
      const opts = { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind"] };
      observer.observe(document.body, opts);
      observer.observe(document.documentElement, opts);
      return () => observer.disconnect();
    }, []);
    return <FluentProvider theme={theme}>{children}</FluentProvider>;
  }

  const container = document.getElementById("root");
  if (container) createRoot(container).render(<Root />);
}
