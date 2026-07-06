// Direct unit tests for the module-loading helpers: `findTemplate`,
// `importTemplateInput`, `loadScenarios` (the missing/broken/wrong-export
// contract), `safeJson`, and the `--stdin` temp-file lifecycle. Scaffolded
// fixtures live in an in-package `.tmp-libtest-*` dir so their `@tdk/core`
// imports resolve (see ./__fixtures__/scaffold.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Template } from "@tdk/core";
import { GREETING_TEMPLATE, makePkgTmp, scaffoldTemplate } from "./__fixtures__/scaffold.ts";
import {
  findTemplate,
  importTemplateInput,
  loadScenarios,
  safeJson,
  scenariosPathFor,
  withStdinTempFile,
} from "./load.ts";

let pkgTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

describe("findTemplate", () => {
  test("picks the default export when it is a Template", async () => {
    const mod = (await import(GREETING_TEMPLATE)) as Record<string, unknown>;
    const found = findTemplate(mod);
    expect(found).toBeInstanceOf(Template);
    expect((found as Template).id).toBe("cake-order-fixture");
  });

  test("returns undefined when no export is a Template", () => {
    expect(findTemplate({ nothing: 1, other: "x" })).toBeUndefined();
  });
});

describe("importTemplateInput", () => {
  test("returns the Template a module exports", async () => {
    const tpl = await importTemplateInput(GREETING_TEMPLATE);
    expect(tpl.id).toBe("cake-order-fixture");
  });

  test("throws the defineTemplate hint when a module has no template", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "load-no-template");
    const noTpl = join(dir, "no-template.ts");
    await Bun.write(noTpl, "export const nothing = 1;\n");
    expect(importTemplateInput(noTpl)).rejects.toThrow(/No template found[\s\S]*defineTemplate\(\.\.\.\)/);
  });
});

describe("loadScenarios", () => {
  test("loads the scenarios array from the sibling __fixtures__ file", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "load-scenarios-ok");
    const scenarios = await loadScenarios(join(dir, "template.ts"));
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]!.name).toBe("orders for alice");
  });

  test("a MISSING scenarios file is zero scenarios (never an error)", async () => {
    // A bare template dir with no __fixtures__/scenarios.ts.
    const dir = join(pkgTmp, "load-missing-scenarios");
    await Bun.write(join(dir, "template.ts"), "export const x = 1;\n");
    expect(await loadScenarios(join(dir, "template.ts"))).toEqual([]);
  });

  test("a scenarios file with the WRONG export name throws with the hint", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "load-wrong-export", { scenarios: "export const scenario = [];\n" });
    expect(loadScenarios(join(dir, "template.ts"))).rejects.toThrow(
      /does not export a `scenarios` array[\s\S]*did you mean "scenarios"/,
    );
  });

  test("a scenarios file with a SYNTAX error throws naming the file", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "load-syntax", { scenarios: "const x =\n" });
    const err = await loadScenarios(join(dir, "template.ts")).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Failed to load");
    expect((err as Error).message).toMatch(/scenarios\.ts:1:\d+/);
  });
});

describe("scenariosPathFor", () => {
  test("points at <dir>/__fixtures__/scenarios.ts", () => {
    expect(scenariosPathFor("/a/b/template.ts")).toBe(join("/a/b", "__fixtures__", "scenarios.ts"));
  });
});

describe("safeJson", () => {
  test("coerces a BigInt to a string instead of throwing", () => {
    expect(safeJson({ n: 10n })).toBe('{"n":"10"}');
  });

  test("drops functions and symbols", () => {
    expect(safeJson({ f: () => 1, s: Symbol("x"), keep: 1 })).toBe('{"keep":1}');
  });
});

describe("withStdinTempFile", () => {
  test("writes a temp sibling, runs fn against it, and always removes it", async () => {
    let tmpSeen = "";
    let remapSeen: { from: string; to: string } | undefined;
    const result = await withStdinTempFile(
      GREETING_TEMPLATE,
      "// buffer\n",
      "compile",
      (r) => (remapSeen = r),
      async (tmpPath) => {
        tmpSeen = tmpPath;
        expect(existsSync(tmpPath)).toBe(true);
        expect(readFileSync(tmpPath, "utf8")).toBe("// buffer\n");
        return "value";
      },
    );
    expect(result).toBe("value");
    // Temp file removed after fn.
    expect(existsSync(tmpSeen)).toBe(false);
    // Remap points temp → original, called before fn.
    expect(remapSeen).toEqual({ from: tmpSeen, to: GREETING_TEMPLATE });
  });

  test("removes the temp file even when fn throws", async () => {
    let tmpSeen = "";
    const err = await withStdinTempFile(
      GREETING_TEMPLATE,
      "x\n",
      "execute",
      () => {},
      async (tmpPath) => {
        tmpSeen = tmpPath;
        throw new Error("kaboom");
      },
    ).catch((e) => e as Error);
    expect((err as Error).message).toBe("kaboom");
    expect(existsSync(tmpSeen)).toBe(false);
  });
});
