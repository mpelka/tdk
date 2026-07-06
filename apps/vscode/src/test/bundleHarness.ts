// The bundle smoke-test HARNESS — run as its OWN `bun` process by App.bundle.test.ts,
// once per MODE (`form` or `trace`, from argv). Each mode owns the happy-dom window
// (see WHY A SEPARATE PROCESS) — the two webview bundles each embed their own React
// + React-DOM, so a single window may host only ONE of them.
//
// It builds the real production webview bundles (`webviewBuildConfig`, the same
// config `bun run build` uses — BOTH `main.js` and `traceMain.js`), stands up the VS
// Code webview contract in a happy-dom window, imports the mode's bundle so it
// mounts, drives it through the DOM, and prints one JSON line of results (prefixed
// with RESULT_MARKER) for the test to assert on.
//
// THE HANDSHAKE. Both bundles' React apps subscribe to `window.message` in a useEffect
// AFTER their async mount, then post a `ready` message. A dispatch BEFORE `ready` would
// be dropped outright, so the harness WAITS for the recorded `ready` post (`waitForReady`)
// and only THEN dispatches its template/trace — ONCE. There is no re-dispatch loop: the
// handshake makes a single dispatch deterministic. If a loop were still needed, the
// production extension's own buffered replay-on-`ready` would be broken too.
//
// WHY A SEPARATE PROCESS PER MODE. The bundles embed their OWN React + React-DOM.
// Loading one into the SAME `bun test` process as the App component tests (which
// render with the TEST process's React-DOM) makes the reconcilers fight over the
// shared happy-dom window's node internals ("Attempted to assign to readonly
// property"). Isolating each bundle in a child process gives its React sole ownership
// of the window — the faithful production condition — and keeps the root `bun test`
// run green. The form and trace bundles get SEPARATE child processes for the same
// reason (two React-DOMs must not share one window).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

// Import everything else AFTER the DOM globals exist (user-event captures document
// at import), and use dynamic import so the order is explicit.
const userEvent = (await import("@testing-library/user-event")).default;
const { webviewBuildConfig } = await import("../../build.ts");
const { exampleFormPages } = await import("./compileExample.ts");

// Marker so the parent can find the single result line amid any build/log noise.
// The parent (App.bundle.test.ts) hard-codes the same string by contract rather
// than importing it — importing this module would run the happy-dom registration
// above in the parent's process.
const RESULT_MARKER = "__TDK_BUNDLE_HARNESS__";

/** Which bundle this run exercises — chosen by argv (`form` default, or `trace`). */
const mode = process.argv.includes("trace") ? "trace" : "form";

type FormResult = {
  buildSuccess: boolean;
  buildSize: number;
  rootChildren: number;
  orderTypePresent: boolean;
  /** After Next on the empty required page: the required error rendered (the fix). */
  requiredErrorShown: boolean;
  /** After Next on the empty required page: did it wrongly advance to page 2? */
  advanced: boolean;
  /** Typing into the custom-field input committed into the input. */
  committedValue: string;
  /** The last `valuesChanged` payload posted back to the host. */
  lastValuesChanged: unknown;
  /** Clicking the header env text posted a `pickEnv` message (native-picker affordance). */
  pickEnvPosted: boolean;
  /** The built bundle's validator did NOT throw on a schema carrying `errorMessage`
   *  (ajv-errors is wired through the bundle seam) — validation still runs, so Next
   *  refuses to advance on the still-empty required field. */
  errorMessageSchemaValidates: boolean;
  /** The bundle survived the errorMessage schema — the form is still on screen. */
  stillRenderedAfterPhase2: boolean;
  /** A `source: "yaml"` template rendered its one-line TDK-features note. */
  yamlNoteShown: boolean;
  /** …and hid the env/scenario header affordances (TDK-only pickers). */
  yamlEnvHidden: boolean;
  /** …and hid the Save as scenario button (writes __fixtures__/scenarios.ts). */
  yamlSaveHidden: boolean;
  /** …while the FORM itself still rendered (the yaml source is a first-class form). */
  yamlFormRendered: boolean;
  /** A `dryRunCapability { configured: false }` DISABLES the Dry-run button + shows the hint (item #5). */
  dryRunButtonDisabled: boolean;
  /** A later `configured: true` LIVE re-enables the Dry-run button (item #5). */
  dryRunButtonReEnabled: boolean;
};

type TraceResult = {
  buildSuccess: boolean;
  buildSize: number;
  rootChildren: number;
  /** After a `trace` message, a rail row rendered (the trace bundle handles it). */
  traceRailRendered: boolean;
  /** A provenance row (templated leaf) rendered its source expression. */
  provenanceRendered: boolean;
  /** After a `dryRunResult` message, the labeled Backstage-dry-run origin rendered. */
  dryRunOriginRendered: boolean;
  /** The dry-run's emitted-file link rendered (the Files section survived the bundle). */
  dryRunFileRendered: boolean;
  /** After a `dryRunResult` with kind validationFailed, the error list rendered. */
  dryRunValidationRendered: boolean;
  /** A `dryRunResult` carrying `history` renders the `Run N of M` indicator (item #4). */
  dryRunRunIndicatorRendered: boolean;
  /** A skipped-step dry-run renders the ⤼ skipped body + expression-only inputs (items #1/#2). */
  dryRunSkippedRendered: boolean;
};

/** Let React effects, the mount, and message handling flush. */
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the document body text currently contains `needle`. */
const bodyHas = (needle: string): boolean => (document.body.textContent ?? "").includes(needle);

/**
 * Poll until `cond()` holds (25ms steps, generous deadline). A FIXED sleep raced the
 * ~19 MB bundle's async mount under load — flaking in CI — so every read below waits
 * on its condition instead of a blind tick.
 */
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await tick();
  }
  return cond();
}

/** Post a `template` message carrying a compiled example's pages (form bundle). */
function postTemplate(example: string): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "template", templateId: "t", title: "Cake Wizard", env: "test", pages: exampleFormPages(example) },
    }),
  );
}

/**
 * Wait for the bundle's React app to post its `ready` handshake back to the host. The
 * app's message listener attaches in a useEffect AFTER the async mount and posts
 * `ready` right after — so a dispatch BEFORE `ready` would be lost. Gating on the
 * RECORDED `ready` post is the honest handshake: once it lands, a single dispatch is
 * guaranteed to be heard, and the old re-dispatch loop is no longer needed. (If it
 * were, the handshake would be broken — that is exactly what this proves.)
 */
async function waitForReady(): Promise<boolean> {
  return waitFor(() => posts.some((p) => p.type === "ready"));
}

const outdir = mkdtempSync(join(tmpdir(), "tdk-webview-bundle-"));
const build = await Bun.build(webviewBuildConfig(outdir));
if (!build.success) for (const log of build.logs) console.error(log);

// The VS Code webview contract: a recording `acquireVsCodeApi`, a `#root`, the
// vscode-dark body class — the same shell both bundles boot into.
const posts: { type: string; values?: unknown }[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage(m: unknown): void } }).acquireVsCodeApi = () => ({
  postMessage: (m) => posts.push(m as { type: string }),
});
document.body.innerHTML = '<div id="root"></div>';
document.body.className = "vscode-dark";

if (mode === "trace") {
  // --- TRACE bundle ---------------------------------------------------------
  const result: Partial<TraceResult> = { buildSuccess: build.success, buildSize: buildSizeOf("traceMain.js") };
  await import(join(outdir, "traceMain.js"));
  await waitFor(() => (document.getElementById("root")?.children.length ?? 0) > 0);
  result.rootChildren = document.getElementById("root")?.children.length ?? 0;

  // Wait for the trace app's `ready` handshake, THEN dispatch the trace ONCE. The
  // handshake guarantees the listener is attached, so a single dispatch is heard — no
  // re-dispatch loop (if one were needed, the handshake would be broken).
  await waitForReady();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "trace",
        ok: true,
        title: "Cake Wizard",
        steps: [
          {
            id: "log-order",
            status: "ran",
            input: { message: "Order type: standard" },
            output: {},
            provenance: [
              {
                key: "message",
                kind: "leaf",
                expression: "Order type: ${{ parameters.orderType }}",
                value: "Order type: standard",
                templated: true,
              },
            ],
            context: { parameters: { orderType: "standard" } },
          },
        ],
        output: { orderType: "standard" },
      },
    }),
  );
  await waitFor(() => !!document.querySelector('[data-testid="trace-rail-log-order"]'));
  result.traceRailRendered = !!document.querySelector('[data-testid="trace-rail-log-order"]');
  result.provenanceRendered = !!document.querySelector('[data-testid="prov-expr-message"]');

  // The NEW dry-run slot. A `dryRunResult` (ok) must survive the same bundler seam: the
  // endpoint-labeled Backstage-dry-run slot header + the emitted-file link render, and the
  // steps are the NORMALIZED `TraceStep[]` (provenance + per-step log), so the dry-run auto-
  // switches to its tab. Then a `validationFailed` result must render its error list too.
  // Both are single dispatches (the app stays subscribed after `ready`).
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "dryRunResult",
        title: "Cake Wizard",
        kind: "ok",
        endpoint: { baseUrl: "http://localhost:7007", status: "200", durationMs: 12 },
        preamble: [{ message: "Starting up task with 1 steps" }],
        steps: [
          {
            id: "log-order",
            status: "ran",
            input: { message: "Order type: standard" },
            output: undefined,
            provenance: [
              {
                key: "message",
                kind: "leaf",
                expression: "Order type: ${{ parameters.orderType }}",
                value: "Order type: standard",
                templated: true,
              },
            ],
            context: { parameters: { orderType: "standard" } },
            log: [{ status: "completed", message: "Finished step Log" }],
          },
        ],
        output: { orderType: "standard" },
        files: [{ path: "recipe.txt", executable: false, content: "flour and sugar" }],
      },
    }),
  );
  await waitFor(() => !!document.querySelector('[data-testid="dryrun-view"]'));
  result.dryRunOriginRendered = !!document.querySelector('[data-testid="dryrun-endpoint"]');
  result.dryRunFileRendered = !!document.querySelector('[data-testid="dryrun-file-recipe.txt"]');

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "dryRunResult",
        title: "Cake Wizard",
        kind: "validationFailed",
        endpoint: { baseUrl: "http://localhost:7007", status: "400", durationMs: 5 },
        errors: [{ where: "flavor", message: 'requires property "flavor"' }],
      },
    }),
  );
  await waitFor(() => !!document.querySelector('[data-testid="dryrun-validation"]'));
  result.dryRunValidationRendered = !!document.querySelector('[data-testid="dryrun-error-flavor"]');

  // A dry-run carrying run HISTORY (item #4) renders the `Run N of M` indicator, AND a
  // SKIPPED step (item #1) renders the ⤼ body + expression-only inputs (item #2) — both must
  // survive the bundler seam. One dispatch (the app stays subscribed after `ready`).
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "dryRunResult",
        title: "Cake Wizard",
        kind: "ok",
        endpoint: { baseUrl: "http://localhost:7007", status: "200", durationMs: 8 },
        history: { index: 1, total: 2, timestamp: Date.UTC(2026, 6, 5, 22, 13, 56), label: "ok" },
        preamble: [{ message: "Starting up task with 4 steps" }],
        steps: [
          {
            id: "rush-ticket",
            status: "skipped",
            input: {},
            output: undefined,
            provenance: [{ key: "message", kind: "leaf", expression: "${{ parameters.x }}" }],
            context: { parameters: {} },
            log: [{ status: "skipped", message: "Skipping step rush-ticket because its if condition was false" }],
          },
        ],
        output: {},
        files: [],
      },
    }),
  );
  await waitFor(() => !!document.querySelector('[data-testid="dryrun-run-indicator"]'));
  result.dryRunRunIndicatorRendered = (
    document.querySelector('[data-testid="dryrun-run-label"]')?.textContent ?? ""
  ).includes("Run 2 of 2");
  // The skipped step is auto-selected (only step) — its skipped body + expression-only input.
  const skipBody = document.querySelector('[data-testid="trace-skipped"]');
  const inputsText = document.querySelector('[data-testid="trace-inputs"]')?.textContent ?? "";
  result.dryRunSkippedRendered =
    !!skipBody && inputsText.includes("${{ parameters.x }}") && !inputsText.includes("undefined");

  console.log(RESULT_MARKER + JSON.stringify(result));
} else {
  // --- FORM bundle ----------------------------------------------------------
  const result: Partial<FormResult> = { buildSuccess: build.success, buildSize: buildSizeOf("main.js") };
  await import(join(outdir, "main.js"));
  await waitFor(() => (document.getElementById("root")?.children.length ?? 0) > 0);
  result.rootChildren = document.getElementById("root")?.children.length ?? 0;

  // The honest handshake: wait for the form app's `ready` post, THEN dispatch the
  // template ONCE. `ready` means the listener is attached, so a single dispatch lands
  // — the old re-dispatch loop is gone (its return would have proven the handshake
  // broken). Every later scenario dispatch below is likewise a single message: the app
  // stays subscribed after the one mount, so nothing needs re-posting.
  await waitForReady();

  // Scenario A — render page 1 of conditional-forms, then Next on the empty required
  // page. This is the bug-class probe: Next calls the Form's validateForm(); the
  // pre-fix `default as validator` throws there (no error renders), the fix surfaces
  // the required-property error and refuses to advance. `transformErrors` rewrites
  // ajv's phrasing, so the visible text now reads "… is required".
  postTemplate("conditional-forms");
  result.orderTypePresent = await waitFor(() => !!document.getElementById("root_orderType"));
  const next = [...document.querySelectorAll("button")].find((b) => b.textContent === "Next");
  const user = userEvent.setup({ document });
  await user.click(next as HTMLButtonElement);
  await waitFor(() => /is required/i.test(document.body.textContent ?? ""), 3_000);
  result.requiredErrorShown = /is required/i.test(document.body.textContent ?? "");
  result.advanced = !!document.getElementById("root_packaging");

  // The header env affordance posts a `pickEnv` (the native-picker round-trip).
  const envBtn = document.querySelector('[data-testid="pick-env"]') as HTMLButtonElement | null;
  if (envBtn) await user.click(envBtn);
  result.pickEnvPosted = posts.some((p) => p.type === "pickEnv");

  // Scenario B — round-trip a value through the bundle: re-point at plugin-composed
  // (the mounted App swaps pages in place on a new template message) and type into
  // the custom-field fallback input; assert it commits and posts. One dispatch — the
  // app is already subscribed.
  postTemplate("plugin-composed");
  await waitFor(() => [...document.querySelectorAll("input")].some((i) => i.type === "text"));
  const input = [...document.querySelectorAll("input")].find((i) => i.type === "text") as HTMLInputElement | undefined;
  if (input) {
    await user.click(input);
    await user.keyboard("deck-3000");
    result.committedValue = input.value;
  }
  result.lastValuesChanged = posts.filter((p) => p.type === "valuesChanged").at(-1)?.values;

  // Scenario C — a schema carrying `errorMessage` (ajv-errors) must survive the
  // bundler seam. The RISK is CJS interop: `import ajvErrors from "ajv-errors"` and
  // `import Ajv from "ajv"` bind the wrong shape if the interop is off, which would
  // make the built validator THROW when it compiles a schema — exactly the failure
  // class of the original dead-form bug. We post such a schema and click Next: if the
  // validator throws, validateForm() throws and the stepper wrongly advances (or the
  // form blanks); if it is wired correctly, validation runs and refuses to advance on
  // the still-empty required field. (The AUTHORED message's field-level RENDERING is
  // asserted at the source level in formValidator.test.ts — the FluentUI-RC theme
  // does not paint field-level error text under happy-dom, only the RJSF-native
  // required routing does, a documented environment gap.)
  const errorMessageSchema = {
    type: "template",
    templateId: "t",
    title: "Cake Wizard",
    env: "test",
    pages: [
      {
        title: "Slot",
        schema: {
          type: "object",
          required: ["slot"],
          properties: {
            slot: {
              type: "string",
              title: "Slot",
              pattern: "^(morning|noon|evening)$",
              errorMessage: "Please choose morning, noon, or evening.",
            },
          },
        },
        uiSchema: {},
      },
    ],
  };
  // One dispatch — the app has been subscribed since its `ready` handshake.
  window.dispatchEvent(new MessageEvent("message", { data: errorMessageSchema }));
  await waitFor(() => !!document.getElementById("root_slot"));
  const next2 = [...document.querySelectorAll("button")].find((b) => b.textContent === "Next");
  if (next2) await user.click(next2);
  await tick(400);
  // The validator ran (no throw) and refused to advance on the empty required field:
  // still on the Slot page, not the Review. A thrown validator would have advanced.
  result.errorMessageSchemaValidates = !!document.getElementById("root_slot") && !bodyHas("Review — the values");
  result.stillRenderedAfterPhase2 = !!document.getElementById("root_slot");

  // Scenario D — a `source: "yaml"` template (a PLAIN YAML Scaffolder template preview)
  // must survive the bundler seam too: the one-line TDK-features note renders, the
  // env/scenario/save affordances hide, and the FORM still renders its page. One
  // dispatch — the app stays subscribed.
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "template",
        templateId: "cake-order.yaml",
        title: "Cake Order (YAML)",
        env: "test",
        source: "yaml",
        pages: [
          {
            title: "Order",
            schema: {
              type: "object",
              required: ["flavor"],
              properties: { flavor: { type: "string", title: "Flavor" } },
            },
            uiSchema: {},
          },
        ],
      },
    }),
  );
  await waitFor(() => !!document.getElementById("root_flavor"));
  result.yamlNoteShown = !!document.querySelector('[data-testid="yaml-note"]');
  result.yamlEnvHidden =
    !document.querySelector('[data-testid="pick-env"]') && !document.querySelector('[data-testid="pick-scenario"]');
  result.yamlSaveHidden = ![...document.querySelectorAll("button")].some((b) => b.textContent === "Save as scenario");
  result.yamlFormRendered = !!document.getElementById("root_flavor");

  // Scenario E — the Dry-run button gated on configuration (item #5) must survive the bundle
  // seam. Post a single-page template with NO required field (so Review is reachable), drive
  // to Review, then toggle the capability: `configured: false` disables the button + shows
  // the hint; a later `configured: true` LIVE re-enables it. Single dispatches — the app is
  // subscribed since `ready`.
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "template",
        templateId: "gated.ts",
        title: "Gated Cake",
        env: "test",
        pages: [
          {
            title: "Order",
            schema: { type: "object", properties: { note: { type: "string", title: "Note" } } },
            uiSchema: {},
          },
        ],
      },
    }),
  );
  await waitFor(() => !!document.getElementById("root_note"));
  const reviewBtn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Review");
  if (reviewBtn) await user.click(reviewBtn);
  await waitFor(() => !!document.querySelector('[data-testid="dry-run-submit"]'));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "dryRunCapability", configured: false } }));
  await waitFor(
    () => (document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement | null)?.disabled === true,
  );
  result.dryRunButtonDisabled =
    (document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement | null)?.disabled === true &&
    !!document.querySelector('[data-testid="dry-run-hint"]');
  window.dispatchEvent(new MessageEvent("message", { data: { type: "dryRunCapability", configured: true } }));
  await waitFor(
    () => (document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement | null)?.disabled === false,
  );
  result.dryRunButtonReEnabled =
    (document.querySelector('[data-testid="dry-run-submit"]') as HTMLButtonElement | null)?.disabled === false;

  console.log(RESULT_MARKER + JSON.stringify(result));
}

/** The size of a named output file from the (multi-entry) build, for the size sanity check. */
function buildSizeOf(basename: string): number {
  const out = build.outputs.find((o) => o.path.endsWith(basename));
  return out?.size ?? build.outputs[0]?.size ?? 0;
}
