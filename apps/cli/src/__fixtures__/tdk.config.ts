// A minimal TDK config used by the CLI tests for `tdk build`. One template fanned
// out to a nonprod (test) and prod target. The output dirs are relative to this
// file; the `build --stdout` test never writes, and the write test points the
// runner at a throwaway temp dir via an explicit `-c`/positional config so the
// on-disk defaults here are only exercised through a copied-into-tmp config.

import { defineConfig } from "@tdk/core";
import CakeOrder from "./greeting/template.ts";

export default defineConfig({
  templates: [CakeOrder],
  targets: {
    nonprod: { env: "test", outDir: "./out-nonprod" },
    prod: { env: "prod", outDir: "./out-prod" },
  },
});
