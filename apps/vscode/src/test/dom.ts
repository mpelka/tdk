// Shared DOM setup for the webview React tests (src/webview/*.test.tsx). Every such
// test file imports this FIRST, before it imports React / RTL / App — the DOM globals
// below must be in place before those modules load.
//
// Imported at the top of each test file rather than wired as a `bunfig.toml` preload
// ON PURPOSE: a per-package `[test] preload` is honoured only when `bun test` runs FROM
// that package's directory, NOT from the repo root (where CI runs it), so a preload
// would leave the root run without a DOM. A plain import is picked up identically either
// way. The registration is idempotent, so importing it from several test files in one
// process is safe.
//
// Register happy-dom's globals (document, window, MutationObserver, …) so RTL can render
// React into a document.
//
// NOTE — the `@rjsf/core` peer gap. `@rjsf/fluentui-rc` imports `@rjsf/core` without
// declaring it (an upstream packaging bug), so under Bun's ISOLATED linker the sibling
// was missing and a runtime `import "@rjsf/core"` from inside fluentui-rc threw "Cannot
// find module". This used to be papered over here with a cache-symlink shim that
// mutated bun's machine-global links cache at test time. It is now fixed properly at the
// source: a `bun patch` on `@rjsf/fluentui-rc` (patches/, wired via root
// `patchedDependencies`) declares `@rjsf/core` as a real dependency, so the isolated
// linker materializes the sibling for BOTH the test runtime and the bundler. No shim.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}
