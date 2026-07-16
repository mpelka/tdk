// LAYER 2 for the extension HOST bundle — the seam where the new `@tdk/core` imports
// could break. `formPreview.ts` imports `fromYaml` from `@tdk/core` and `dryRun.ts`
// imports the client from `@tdk/core/backstage`; neither is external for the host bundle,
// so both must RESOLVE (through the package.json `exports` map, including the `./backstage`
// subpath) and INLINE cleanly through the production `Bun.build` config.
//
// A subpath export-map bug, a missing dependency link, or an ESM/CJS interop trap in the
// client would surface here as a build failure or a bundle missing the code — the App
// bundle test (webview) cannot see the host bundle, so this is its own layer.
//
// It builds the EXACT production host bundle (`extensionBuildConfig`, shared with
// `bun run build`) into a scratch dir, then asserts markers unique to core's modules made
// it into the emitted JS — proof the subpath resolved and the code was really inlined.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extensionBuildConfig } from "../build.ts";

test("the extension host bundle builds with the @tdk/core subpath resolved and inlined", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "tdk-ext-bundle-"));
  const result = await Bun.build(extensionBuildConfig(outdir));
  if (!result.success) {
    throw new Error(`extension host bundle failed:\n${result.logs.map(String).join("\n")}`);
  }
  expect(result.success).toBe(true);

  const artifact = result.outputs.find((o) => o.path.endsWith("extension.js"));
  expect(artifact).toBeDefined();
  const code = await artifact!.text();

  // The `@tdk/core/backstage` subpath resolved and its client was inlined: the dry-run
  // endpoint constant only lives in core's client.
  expect(code).toContain("/api/scaffolder/v2/dry-run");
  // The `@tdk/core` main import resolved and `fromYaml` was inlined: this reason string
  // only lives in core's fromYaml.
  expect(code).toContain("no YAML document found");
});
