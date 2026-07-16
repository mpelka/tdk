// The extension's bundler — two `Bun.build` entries sharing one config, driven by
// the `Bun.build` API (no esbuild). We ship THREE bundles from the ONE package:
//
//   1. the EXTENSION HOST (`src/extension.ts` → `dist/extension.js`): runs in
//      VS Code's Node-based host, so target `node`, format `cjs`, and `vscode`
//      stays external (the host injects it — it must never be bundled).
//   2. + 3. the two WEBVIEW APPS — the FORM panel (`src/webview/main.tsx` →
//      `dist/webview/main.js`) and the TDK Trace VIEW (`src/webview/traceMain.tsx` →
//      `dist/webview/traceMain.js`). Both run in a browser-like WebView, so they
//      share ONE `Bun.build` with BOTH entrypoints (target `browser`, React's
//      `process.env.NODE_ENV` DEFINEd to `"production"` — React reads it at module
//      scope; leaving it undefined pulls in dev-only warnings + crashes on the
//      missing `process` global). One build with two entrypoints keeps the single
//      `pinPeers` plugin arrangement intact — both bundles resolve React/RJSF/Fluent
//      through the same seam, and Bun emits a shared chunk for the common code
//      instead of duplicating React+Fluent into each file.
//
// All emit sourcemaps. `bun run build.ts` builds once; `--watch` rebuilds on any
// change under `src/` (a debounced `fs.watch` loop — the simplest thing that works,
// and it covers ALL entries from one watcher, which per-entry `bun build --watch`
// processes would not).
//
// The webview build config (`webviewBuildConfig`) and its peer-pinning
// (`resolvePinnedPeer` / `pinPeers`) are EXPORTED so the bundle smoke test can build
// the exact production webview bundles through one shared definition of the bundler
// seam. Nothing runs a build on import: the `Bun.build` entries only fire under
// `import.meta.main` (guarded below).

import * as fs from "node:fs";
import * as path from "node:path";

/** This package's root — where every webview peer is linked (see PINNED_PEER_ROOTS). */
export const root = import.meta.dir;
const src = path.join(root, "src");

/** Shared build options; each entry overrides target/format/entrypoint/outdir. */
const common = {
  sourcemap: "linked",
  // Never throw out of the whole watch loop on a single bad build — we inspect
  // `result.success` and log the diagnostics ourselves, then keep watching.
  throw: false,
} as const;

/**
 * The extension-host bundle's Bun.build config: Node + CJS, with `vscode` left external.
 * Exported as a factory (taking the outdir) — like `webviewBuildConfig` — so the bundle
 * smoke test builds the EXACT production host bundle into a scratch dir while `build.ts`
 * builds it into `dist`. This is where the `@tdk/core` / `@tdk/core/backstage` import seam
 * gets exercised through the production bundler: neither is external, so both are inlined,
 * and a resolution/interop bug in the subpath export map surfaces here as a build failure.
 */
export function extensionBuildConfig(outdir: string): Bun.BuildConfig {
  return {
    ...common,
    entrypoints: [path.join(src, "extension.ts")],
    outdir,
    target: "node",
    format: "cjs",
    external: ["vscode"],
  };
}

/** The extension-host bundle: Node + CJS, with `vscode` left external. */
function buildExtension(): Promise<Bun.BuildOutput> {
  return Bun.build(extensionBuildConfig(path.join(root, "dist")));
}

// The webview's peer packages, all declared as DIRECT deps of this package so they
// are linked into `apps/vscode/node_modules`. We redirect these bare specifiers to
// resolve from THIS package's node_modules, guaranteeing a SINGLE copy of each in the
// bundle. This is a DEDUP guarantee, not a peer-gap workaround:
//
//   - react / react-dom — two Reacts (one reached through Fluent/RJSF, one direct)
//     would break hooks. Bundle grep confirms the pin's effect: drop them and the built
//     webview resolves React through a different path (the react-core marker changes).
//   - @rjsf/ — the app imports `@rjsf/core` DIRECTLY (App.tsx) and `@rjsf/fluentui-rc`
//     (which imports `@rjsf/core` transitively). Those two `@rjsf/core` requires can
//     resolve to the same VERSION at two different physical paths (e.g. the app's
//     direct link vs. fluentui-rc's materialized sibling, which may point into a
//     different bun cache), and the bundler then embeds TWO copies — splitting
//     `@rjsf/core`'s module-scope state (a `ReferenceError` from one copy's helper
//     referenced by the other). Pinning `@rjsf/` collapses every `@rjsf/*` require onto
//     this package's single set.
//
// SEPARATE from the pin: the phantom `@rjsf/core` peer. `@rjsf/fluentui-rc` imports
// `@rjsf/core` WITHOUT declaring it (an upstream packaging bug), so under the isolated
// linker its `@rjsf/core` sibling was missing and a bare require from inside fluentui-rc
// failed at RUNTIME (bun test) and at BUILD (following the symlink). That RUNTIME gap was
// the last thing the test-time cache-symlink shim covered; both are now fixed at the
// source by a `bun patch` on `@rjsf/fluentui-rc` (patches/, wired via root
// `patchedDependencies`) declaring `@rjsf/core` as a real dependency — so the linker
// materializes the sibling for both. The `@rjsf/` pin still stays for the DEDUP reason
// above (verified: dropping it breaks the built form bundle at runtime).
export const PINNED_PEER_ROOTS = ["react", "react-dom", "@rjsf/", "@fluentui/"];

/**
 * Resolve a bare peer specifier (React, React-DOM, RJSF, Fluent) from THIS package's
 * node_modules, so the bundle embeds a single copy of each. Returns the resolved
 * absolute path for a matching bare specifier, or `undefined` to fall through to
 * the default resolver (a relative/absolute path, a non-peer package, or an
 * unresolvable one). Used by the bundler's `pinPeers` plugin.
 */
export function resolvePinnedPeer(spec: string): string | undefined {
  // Only bare specifiers (a package name, not a relative/absolute path).
  if (spec.startsWith(".") || spec.startsWith("/")) return undefined;
  const isPeer = PINNED_PEER_ROOTS.some((r) =>
    r.endsWith("/") ? spec.startsWith(r) : spec === r || spec.startsWith(`${r}/`),
  );
  if (!isPeer) return undefined;
  try {
    // Resolve from THIS package's node_modules (root has a package.json).
    return Bun.resolveSync(spec, root);
  } catch {
    return undefined; // let the default resolver try (and error clearly)
  }
}

/**
 * A resolver plugin that pins the webview's peer packages (React, React-DOM, RJSF,
 * Fluent) to `apps/vscode/node_modules`, so the bundle embeds a single copy of each.
 * Only bare specifiers matching `PINNED_PEER_ROOTS` are redirected; everything else
 * falls through to Bun's normal resolution. (The phantom `@rjsf/core` peer is supplied
 * separately by the bun patch — see `PINNED_PEER_ROOTS` above.)
 */
export const pinPeers: Bun.BunPlugin = {
  name: "pin-webview-peers",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const resolved = resolvePinnedPeer(args.path);
      return resolved ? { path: resolved } : undefined;
    });
  },
};

/**
 * The webview bundle's Bun.build config: browser target, React pinned to its
 * production build, minified. Exported (as a factory taking the outdir) so the
 * bundle smoke test builds the EXACT production webview bundles into a scratch dir
 * while `build.ts` builds them into `dist/webview` — one config, two consumers.
 *
 * BOTH webview entrypoints (the form `main.tsx` and the trace `traceMain.tsx`) build
 * together here: `outputs[0]` is `main.js` (entry order), and Bun emits a shared
 * chunk for the React/Fluent/RJSF code both import, so the trace bundle is small.
 */
export function webviewBuildConfig(outdir: string): Bun.BuildConfig {
  return {
    ...common,
    entrypoints: [path.join(src, "webview", "main.tsx"), path.join(src, "webview", "traceMain.tsx")],
    outdir,
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
    // Minify the webview bundles — they ship React + Fluent + RJSF + ajv and still
    // land around 18 MB minified (granular Fluent imports are a later optimization;
    // the bundle loads from local disk, not the network). The sourcemap keeps it
    // debuggable. (The extension bundle stays unminified for readable host stacks.)
    minify: true,
    plugins: [pinPeers],
  };
}

/** The webview bundle: browser target, React pinned to its production build. */
function buildWebview(): Promise<Bun.BuildOutput> {
  return Bun.build(webviewBuildConfig(path.join(root, "dist", "webview")));
}

/** Build both bundles; log each result and return whether everything succeeded. */
async function buildAll(): Promise<boolean> {
  const results = await Promise.all([buildExtension(), buildWebview()]);
  let ok = true;
  for (const result of results) {
    if (!result.success) {
      ok = false;
      for (const log of result.logs) console.error(log);
    }
  }
  const stamp = new Date().toLocaleTimeString();
  console.log(ok ? `[${stamp}] build ok` : `[${stamp}] build FAILED`);
  return ok;
}

// Only run a build when invoked as the entrypoint (`bun run build.ts`) — importing
// this module (the smoke test, the test-runtime peer pin) must NOT trigger one.
if (import.meta.main) {
  const watch = process.argv.includes("--watch");

  const ok = await buildAll();

  if (watch) {
    console.log("watching src/ for changes…");
    // One recursive watcher over src/ rebuilds BOTH bundles — a coarse but reliable
    // trigger. Debounce so a burst of editor saves collapses into a single rebuild.
    let timer: ReturnType<typeof setTimeout> | undefined;
    fs.watch(src, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void buildAll(), 100);
    });
  } else if (!ok) {
    process.exit(1);
  }
}
