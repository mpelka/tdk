// Direct unit tests for `runInit` — the scaffold + first-baseline operation.
// Assert on the created files, the written snapshot, and the overwrite refusal.
// Scaffolds into an in-package `.tmp-libtest-*` dir so `@tdk/core` resolves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { makePkgTmp } from "./__fixtures__/scaffold.ts";
import { runInit } from "./init.ts";
import { runTemplateTest } from "./test.ts";

let pkgTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

describe("runInit", () => {
  test("scaffolds template + scenarios + config + first snapshot", async () => {
    const dir = join(pkgTmp, "init-here");
    const result = await runInit(dir);
    expect(result.dir).toBe(dir);
    for (const f of ["template.ts", join("__fixtures__", "scenarios.ts"), "tdk.config.ts"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(result.snapshot)).toBe(true);
    expect(result.files).toHaveLength(3);

    // The scaffold is immediately green under --ci.
    const ci = await runTemplateTest(join(dir, "template.ts"), dir, { update: false, ci: true });
    expect(ci.ok).toBe(true);
    expect(ci.scenarios.every((s) => s.status === "passed")).toBe(true);
  });

  test("refuses to overwrite existing files", async () => {
    const dir = join(pkgTmp, "init-here"); // already scaffolded above
    const err = await runInit(dir).catch((e) => e as Error);
    expect((err as Error).message).toContain("refusing to overwrite");
  });
});
