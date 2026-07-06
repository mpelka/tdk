// LAYER 2 — the built-bundle smoke test (the layer that catches interop bugs).
//
// Spawns `bundleHarness.ts` in its OWN `bun` process, ONCE PER MODE (form + trace).
// Each run builds the REAL production webview bundles with the EXACT same Bun.build
// config as `bun run build` (`webviewBuildConfig` — same entrypoints, browser target,
// `process.env.NODE_ENV` define, minify, and the `pinPeers` plugin), stands up the VS
// Code webview contract in a happy-dom window, imports the mode's bundle so it mounts,
// drives it through the DOM, and prints a JSON result this test asserts on. A child
// process because each bundle carries its own React-DOM, which must not share a window
// with this process's React-DOM OR with the other bundle's (see bundleHarness.ts).
//
// WHY THIS LAYER EXISTS. The dead-form bug (fixed in 92706a9) was a CJS-interop trap:
// a `default`-imported `@rjsf/validator-ajv8` binds the module NAMESPACE under BROWSER
// BUNDLING, whose `.isValid` is not a function, so every RJSF validation throws. It
// reproduces ONLY through the bundler seam — under the App component tests' runtime
// loader (layer 1) that same import resolves fine, so that layer cannot see it. Here,
// `requiredErrorShown` asserts Next's validateForm() surfaced the required error, and
// `authoredErrorShown` asserts the NEW ajv-errors validator (also a NAMED import) runs
// through the bundle. Verified by hand: reverting to a `default as` import makes
// validateForm() THROW, the harness reports `false`, and this test FAILS.
//
// HAPPY-DOM GAP (documented, not faked): Fluent v9's <Dropdown> popup needs real
// browser layout, so an enum option cannot be clicked. The bug-catching interactions
// are therefore Next's validateForm() and a text-field commit, driven via the DOM.

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Kept in sync with bundleHarness.ts by contract — NOT imported from it, because that
// module registers happy-dom and pulls in the browser deps at load, which must happen
// only in the spawned child, never in this test process.
const RESULT_MARKER = "__TDK_BUNDLE_HARNESS__";

type FormResult = {
  buildSuccess: boolean;
  buildSize: number;
  rootChildren: number;
  orderTypePresent: boolean;
  requiredErrorShown: boolean;
  advanced: boolean;
  committedValue: string;
  lastValuesChanged: unknown;
  pickEnvPosted: boolean;
  errorMessageSchemaValidates: boolean;
  stillRenderedAfterPhase2: boolean;
  yamlNoteShown: boolean;
  yamlEnvHidden: boolean;
  yamlSaveHidden: boolean;
  yamlFormRendered: boolean;
  dryRunButtonDisabled: boolean;
  dryRunButtonReEnabled: boolean;
};

type TraceResult = {
  buildSuccess: boolean;
  buildSize: number;
  rootChildren: number;
  traceRailRendered: boolean;
  provenanceRendered: boolean;
  dryRunOriginRendered: boolean;
  dryRunFileRendered: boolean;
  dryRunValidationRendered: boolean;
  dryRunRunIndicatorRendered: boolean;
  dryRunSkippedRendered: boolean;
};

const harness = join(import.meta.dir, "..", "test", "bundleHarness.ts");

/** Run the harness in one mode and parse its single result line. */
function runHarness<T>(mode: "form" | "trace"): T {
  const run = spawnSync("bun", ["run", harness, mode], { encoding: "utf8", timeout: 180_000 });
  if (run.status !== 0) {
    throw new Error(`bundle harness (${mode}) failed (code ${run.status}):\n${run.stdout}\n${run.stderr}`);
  }
  const line = run.stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
  if (!line) throw new Error(`bundle harness (${mode}) produced no result line:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line.slice(RESULT_MARKER.length)) as T;
}

// Run each harness ONCE (each builds ~19 MB bundles — slow) and share its result
// across that mode's assertions.
const form = runHarness<FormResult>("form");
const trace = runHarness<TraceResult>("trace");

// --- The FORM bundle ----------------------------------------------------------

test("the production webview bundle builds", () => {
  expect(form.buildSuccess).toBe(true);
  // Sanity: the real, whole thing (React + Fluent + RJSF + ajv), many MB.
  expect(form.buildSize).toBeGreaterThan(1_000_000);
});

test("the form bundle mounts and renders page 1 of a real compiled template", () => {
  expect(form.rootChildren).toBeGreaterThan(0);
  expect(form.orderTypePresent).toBe(true);
});

test("Next runs the bundle's validator and surfaces the required error — fails on the pre-fix interop bug", () => {
  // THE bug-class assertion. With the pre-fix `default as validator`, validateForm()
  // throws (`.isValid is not a function`) and no error renders → requiredErrorShown
  // would be false and this fails. With the fix, the (humanized) error appears and
  // the stepper refuses to advance.
  expect(form.requiredErrorShown).toBe(true);
  expect(form.advanced).toBe(false);
});

test("committing a value in the bundle posts valuesChanged back to the host", () => {
  // The webview → extension round-trip through the real bundle: the custom-field
  // fallback input both commits the value and posts it.
  expect(form.committedValue).toBe("deck-3000");
  expect(form.lastValuesChanged).toMatchObject({ ovenModel: "deck-3000" });
});

test("clicking the header env text posts pickEnv (the native-picker affordance) through the bundle", () => {
  expect(form.pickEnvPosted).toBe(true);
});

test("a schema carrying errorMessage validates through the built ajv-errors validator (no interop throw)", () => {
  // The NEW validator (customizeValidator + Ajv + ajv-errors, all NAMED/interop-safe
  // imports) must survive the bundler seam: a schema carrying `errorMessage` compiles
  // and validates without throwing, so Next runs validation and refuses to advance on
  // the empty required field — a mis-interop'd ajv-errors would throw at compile time
  // (the original dead-form failure class). The authored message's field-level DOM
  // RENDERING is asserted at the source level in formValidator.test.ts (the FluentUI
  // theme doesn't paint field errors under happy-dom — a documented environment gap).
  expect(form.errorMessageSchemaValidates).toBe(true);
  expect(form.stillRenderedAfterPhase2).toBe(true);
});

test("a source:yaml template renders the note, hides the TDK-only controls, and still shows the form", () => {
  // The NEW `source` discriminator must survive the bundler seam: a plain-YAML preview
  // message hides env/scenario/save (TDK-compile concepts), shows the quiet one-line
  // note in their place, and the form itself renders as a first-class citizen.
  expect(form.yamlNoteShown).toBe(true);
  expect(form.yamlEnvHidden).toBe(true);
  expect(form.yamlSaveHidden).toBe(true);
  expect(form.yamlFormRendered).toBe(true);
});

test("the Dry-run button gates on the dryRunCapability message and LIVE re-enables (item #5)", () => {
  // The NEW capability message must survive the bundler seam: `configured: false` disables
  // the Review-step Dry-run button + shows the hint; a later `configured: true` re-enables it
  // with no reload.
  expect(form.dryRunButtonDisabled).toBe(true);
  expect(form.dryRunButtonReEnabled).toBe(true);
});

// --- The TRACE bundle ---------------------------------------------------------

test("the trace webview bundle builds and mounts", () => {
  expect(trace.buildSuccess).toBe(true);
  expect(trace.buildSize).toBeGreaterThan(1_000_000);
  expect(trace.rootChildren).toBeGreaterThan(0);
});

test("the trace bundle renders a rail row and a provenance row for a posted trace", () => {
  // The trace protocol messages must survive the real bundler seam: a `trace` message
  // renders a step rail row, and a templated-leaf provenance row shows its expression.
  expect(trace.traceRailRendered).toBe(true);
  expect(trace.provenanceRendered).toBe(true);
});

test("the trace bundle renders the Backstage dry-run origin, files, and validation state (phase 3)", () => {
  // The NEW dry-run protocol messages must survive the bundler seam too: a `dryRunResult`
  // (ok) renders the labeled Backstage-dry-run origin + the emitted-file link, and a
  // `validationFailed` result renders the readable error list. This is the layer-2
  // guarantee that the phase-3 messages don't crash the built trace bundle.
  expect(trace.dryRunOriginRendered).toBe(true);
  expect(trace.dryRunFileRendered).toBe(true);
  expect(trace.dryRunValidationRendered).toBe(true);
});

test("the trace bundle renders the run-history indicator and a skipped step's expression-only body (round 2)", () => {
  // The round-2 dry-run polish must survive the bundler seam: a `dryRunResult` carrying
  // `history` renders the `Run N of M` indicator (item #4), and a `skipped` step renders its
  // ⤼ note with EXPRESSION-ONLY inputs — no fabricated `undefined` (items #1/#2).
  expect(trace.dryRunRunIndicatorRendered).toBe(true);
  expect(trace.dryRunSkippedRendered).toBe(true);
});
