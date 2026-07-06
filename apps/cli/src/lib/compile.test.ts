// Direct unit tests for the compile + build operations. Import the functions and
// assert on their RETURNED data / on-disk effects — no subprocess. Scaffolded
// fixtures live in an in-package `.tmp-libtest-*` dir so their `@tdk/core`
// imports resolve.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG,
  GREETING_TEMPLATE,
  INVALID_TEMPLATE,
  JSONATA_TEMPLATE,
  makePkgTmp,
  scaffoldTemplate,
} from "./__fixtures__/scaffold.ts";
import { buildConfig, buildStdout, compileTemplate, writeBuildJob } from "./compile.ts";

let pkgTmp: string;
let osTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
  osTmp = await mkdtemp(join(tmpdir(), "tdk-lib-compile-"));
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
  await rm(osTmp, { recursive: true, force: true });
});

describe("compileTemplate — single file", () => {
  test("returns YAML for stdout (default test env)", async () => {
    const outcome = await compileTemplate(GREETING_TEMPLATE, {
      fromStdin: false,
      out: undefined,
      env: "test",
      validate: true,
    });
    expect(outcome.kind).toBe("yaml");
    if (outcome.kind !== "yaml") throw new Error("expected yaml");
    expect(outcome.yaml).toContain("kind: Template");
    expect(outcome.yaml).toContain("name: cake-order-fixture");
    expect(outcome.yaml).toContain("cluster: test-cluster");
    expect(outcome.yaml).not.toContain("prod-cluster");
  });

  test("--env prod resolves env.pick to the prod value", async () => {
    const outcome = await compileTemplate(GREETING_TEMPLATE, {
      fromStdin: false,
      out: undefined,
      env: "prod",
      validate: true,
    });
    if (outcome.kind !== "yaml") throw new Error("expected yaml");
    expect(outcome.yaml).toContain("cluster: prod-cluster");
    expect(outcome.yaml).not.toContain("test-cluster");
  });

  test("-o writes the YAML to a file (creating parent dirs) and returns `written`", async () => {
    const outPath = join(osTmp, "nested", "deep", "compiled.yaml");
    const outcome = await compileTemplate(GREETING_TEMPLATE, {
      fromStdin: false,
      out: outPath,
      env: "test",
      validate: true,
    });
    expect(outcome).toEqual({ kind: "written", path: outPath });
    expect(await readFile(outPath, "utf8")).toContain("cluster: test-cluster");
  });

  test("a missing file argument throws a usage error", async () => {
    expect(
      compileTemplate(undefined, { fromStdin: false, out: undefined, env: "test", validate: true }),
    ).rejects.toThrow(/Usage: tdk compile/);
  });

  test("a schema-invalid template fails by default", async () => {
    const dir = join(pkgTmp, "compile-invalid");
    await writeFile(join(dir, "template.ts"), INVALID_TEMPLATE, "utf8").catch(async () => {
      await Bun.write(join(dir, "template.ts"), INVALID_TEMPLATE);
    });
    const err = await compileTemplate(join(dir, "template.ts"), {
      fromStdin: false,
      out: undefined,
      env: "test",
      validate: true,
    }).catch((e) => e as Error);
    expect((err as Error).message).toContain("failed schema validation");
    expect((err as Error).message).toContain("/spec/owner");
  });

  test("compile output is pretty by default: .jsonata bakes multi-line, .compact bakes single-line", async () => {
    const dir = join(pkgTmp, "compile-jsonata");
    await Bun.write(join(dir, "template.ts"), JSONATA_TEMPLATE);
    const outcome = await compileTemplate(join(dir, "template.ts"), {
      fromStdin: false,
      out: undefined,
      env: "test",
      validate: true,
    });
    if (outcome.kind !== "yaml") throw new Error("expected yaml");
    // `.jsonata` (the `expression:` field) carries the pretty multi-line form;
    // `.compact` (the `ticket:` field) is single-line. Both are plain STRINGS —
    // JSONata never renders into a `${{ }}` value (compile rejects that). The
    // accessor an author reads is the only layout control — there is no
    // compile-time override.
    expect(outcome.yaml).toMatch(/expression: \|/);
    expect(outcome.yaml).toContain("$greeting :=");
    expect(outcome.yaml).not.toMatch(/expression: '\$\{\{/);
    expect(outcome.yaml).toMatch(/ticket: .*\$greeting :=.*\n/);
    expect(outcome.yaml).not.toMatch(/ticket: \|/);
  });

  test("--no-validate skips the schema check", async () => {
    const dir = join(pkgTmp, "compile-invalid");
    await Bun.write(join(dir, "template.ts"), INVALID_TEMPLATE);
    const outcome = await compileTemplate(join(dir, "template.ts"), {
      fromStdin: false,
      out: undefined,
      env: "test",
      validate: false,
    });
    if (outcome.kind !== "yaml") throw new Error("expected yaml");
    expect(outcome.yaml).toContain("name: bad-fixture");
  });
});

describe("buildConfig — whole config", () => {
  test("compiles every template × target (one job per target), YAML per env", async () => {
    const jobs = await buildConfig(CONFIG);
    expect(jobs).toHaveLength(2);
    const nonprod = jobs.find((j) => j.targetName === "nonprod")!;
    const prod = jobs.find((j) => j.targetName === "prod")!;
    expect(nonprod.yaml).toContain("cluster: test-cluster");
    expect(prod.yaml).toContain("cluster: prod-cluster");
    expect(nonprod.templateId).toBe("cake-order-fixture");
  });

  test("resolves output paths RELATIVE TO THE CONFIG FILE, not the cwd", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "build-rel");
    await writeFile(
      join(dir, "tdk.config.ts"),
      `import { defineConfig } from "@tdk/core";
import CakeOrder from "./template.ts";
export default defineConfig({
  templates: [CakeOrder],
  targets: {
    nonprod: { env: "test", outDir: "./out-nonprod" },
    prod: { env: "prod", outDir: "./out-prod" },
  },
});
`,
      "utf8",
    );
    const jobs = await buildConfig(join(dir, "tdk.config.ts"));
    // Every out path is under the config's dir — never the cwd.
    for (const job of jobs) expect(job.outPath.startsWith(dir)).toBe(true);
    const nonprod = jobs.find((j) => j.targetName === "nonprod")!;
    expect(nonprod.outPath).toBe(join(dir, "out-nonprod", "cake-order-fixture", "template.yaml"));
  });

  test("validates BEFORE producing jobs — an invalid artifact throws, nothing to write", async () => {
    const dir = join(pkgTmp, "build-invalid");
    await Bun.write(join(dir, "template.ts"), INVALID_TEMPLATE);
    await writeFile(
      join(dir, "tdk.config.ts"),
      `import { defineConfig } from "@tdk/core";
import Bad from "./template.ts";
export default defineConfig({
  templates: [Bad],
  targets: { nonprod: { env: "test", outDir: "./out" }, prod: { env: "prod", outDir: "./out-prod" } },
});
`,
      "utf8",
    );
    const err = await buildConfig(join(dir, "tdk.config.ts")).catch((e) => e as Error);
    expect((err as Error).message).toContain("failed schema validation");
    // buildConfig never writes — the write step is separate.
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  test("a config missing templates/targets throws a clear error", async () => {
    const dir = join(pkgTmp, "build-bad-config");
    await Bun.write(join(dir, "tdk.config.ts"), "export default { nope: true };\n");
    expect(buildConfig(join(dir, "tdk.config.ts"))).rejects.toThrow(/must default-export defineConfig/);
  });
});

describe("buildStdout + writeBuildJob", () => {
  test("buildStdout joins artifacts with a --- marker + trailing newline", async () => {
    const jobs = await buildConfig(CONFIG);
    const out = buildStdout(jobs);
    expect(out.split(/^---$/m)).toHaveLength(2);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toContain("cluster: test-cluster");
    expect(out).toContain("cluster: prod-cluster");
  });

  test("writeBuildJob writes the YAML to its resolved path (creating dirs)", async () => {
    const outPath = join(osTmp, "build-job", "cake-order-fixture", "template.yaml");
    await writeBuildJob({ templateId: "x", targetName: "t", outPath, yaml: "hello: world\n" });
    expect(await readFile(outPath, "utf8")).toBe("hello: world\n");
  });
});
