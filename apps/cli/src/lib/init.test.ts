// Direct unit tests for `runInit` — the scaffold + first-baseline operation.
// Assert on the created files, the written snapshot, and the overwrite refusal.
// Scaffolds into an in-package `.tmp-libtest-*` dir so `@tdk/core` resolves.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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

  test("scaffolds an AUTHORING-V2 template (pages, derive, effect, handle output)", async () => {
    const dir = join(pkgTmp, "init-here"); // scaffolded above
    const template = readFileSync(join(dir, "template.ts"), "utf8");
    // The v2 surface: module-scope fields + pages-as-TOC, a derive, an effect, and
    // a handle-based output — NOT the v1 `parameters`/`steps` closure shape.
    expect(template).toContain("pages:");
    expect(template).toContain("derive(");
    expect(template).toContain("effect<");
    expect(template).toContain("effects:");
    expect(template).toContain("order.output.orderId");
    expect(template).not.toContain("steps: (f)");

    // The compiled artifact reflects it: the derive materializes as a jsonata step,
    // the effect is its own action step, and the output reads the effect by handle.
    const config = await import(join(dir, "template.ts"));
    const { compile } = await import("@tdk/core");
    const { object } = compile(config.default, { env: "test", outDir: "" });
    expect(object.spec.steps.map((s: { id?: string; action: string }) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "order-summary", action: "roadiehq:utils:jsonata" },
      { id: "place-order", action: "bakery:place-order" },
    ]);
    expect(object.spec.output).toEqual({ orderId: "${{ steps['place-order'].output.orderId }}" });
  });

  test("refuses to overwrite existing files", async () => {
    const dir = join(pkgTmp, "init-here"); // already scaffolded above
    const err = await runInit(dir).catch((e) => e as Error);
    expect((err as Error).message).toContain("refusing to overwrite");
  });
});
