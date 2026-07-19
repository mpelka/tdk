import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationModel } from "@tdk/core/migrate";
import { formatMigrateReport, migrateOne, runMigrate, serializeMigrateReport } from "./migrate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "cli.ts");

// A scratch dir INSIDE the package so an emitted template can resolve @tdk/core in
// the compile smoke (Bun walks up to the workspace node_modules).
let pkgTmp: string;
beforeAll(async () => {
  pkgTmp = await mkdtemp(join(here, "..", "..", ".tmp-migrate-"));
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

/** An unmapped model — the compile smoke can pass without any org pack. */
function unmappedModel(id: string): MigrationModel {
  return {
    modelVersion: "1",
    template: { id, title: "T", type: "service" },
    questions: [
      {
        name: "flavor",
        type: "choice",
        options: { vanilla: "Vanilla", chocolate: "Chocolate" },
        required: true,
        exampleValue: "chocolate",
        page: "Cake",
      },
      {
        name: "notes",
        type: "string",
        page: "Cake",
        visibleWhen: { field: "flavor", is: "chocolate" },
        exampleValue: "cocoa",
      },
    ],
    logic: [
      { name: "summary", op: "template", template: "{f} cake", bindings: { f: { op: "fieldRef", field: "flavor" } } },
    ],
    effects: [
      {
        name: "place-order",
        kind: "order",
        actionRef: "legacy:bakery:place-order",
        inputs: { summary: { logicRef: "summary" } },
      },
    ],
    outputs: { orderId: { effectRef: "place-order", path: ["id"] } },
  };
}

async function writeModel(name: string, model: unknown): Promise<string> {
  const path = join(pkgTmp, name);
  await writeFile(path, JSON.stringify(model), "utf8");
  return path;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { stdout, stderr, code: await proc.exited };
}

describe("runMigrate — --validate-only (gate 0)", () => {
  test("a valid model reports ok, writes nothing", async () => {
    const path = await writeModel("valid.json", unmappedModel("vo-valid"));
    const result = await runMigrate([path], { out: pkgTmp, validateOnly: true, force: false });
    expect(result.ok).toBe(true);
    expect(result.models[0].valid).toBe(true);
    expect(result.models[0].outDir).toBeUndefined();
  });

  test("an invalid model reports not-ok with a path-quality typo suggestion", async () => {
    const bad = {
      modelVersion: "1",
      template: { id: "b", title: "B" },
      questions: [{ name: "flavor", type: "string", page: "P", visibleWhen: { field: "flavour", is: "x" } }],
    };
    const path = await writeModel("invalid.json", bad);
    const result = await runMigrate([path], { out: pkgTmp, validateOnly: true, force: false });
    expect(result.ok).toBe(false);
    expect(result.models[0].valid).toBe(false);
    expect(result.models[0].errors[0].path).toBe("questions[0].visibleWhen.field");
    expect(result.models[0].errors[0].message).toBe('"flavour" is not a declared question (did you mean "flavor"?)');
  });

  test("the --json report shape is stable and machine-readable", async () => {
    const path = await writeModel("json.json", unmappedModel("vo-json"));
    const result = await runMigrate([path], { out: pkgTmp, validateOnly: true, force: false });
    const parsed = JSON.parse(serializeMigrateReport(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.models[0].templateId).toBe("vo-json");
    expect(parsed.models[0].valid).toBe(true);
    expect(serializeMigrateReport(result).endsWith("\n")).toBe(true);
  });
});

describe("runMigrate — full run", () => {
  test("emits the three files, a report, and a passing compile smoke", async () => {
    const path = await writeModel("full.json", unmappedModel("full-run"));
    const out = join(pkgTmp, "out-full");
    const result = await runMigrate([path], { out, validateOnly: false, force: false });
    expect(result.ok).toBe(true);
    const m = result.models[0];
    expect(m.files).toHaveLength(3);
    expect(m.report?.counts).toEqual({ translated: 3, flagged: 1 });
    // gate-1-lite: an unmapped model needs no org pack, so the smoke compiles.
    expect(m.smoke?.ok).toBe(true);
    // The emitted template.ts exists and is idiomatic v2.
    const ts = await readFile(join(out, "full-run", "template.ts"), "utf8");
    expect(ts).toContain("export default defineTemplate({");
    expect(ts).toContain('effect("place-order", "legacy:bakery:place-order"');
  });

  test("--force: a second run without --force refuses; with --force it overwrites", async () => {
    const path = await writeModel("force.json", unmappedModel("force-run"));
    const out = join(pkgTmp, "out-force");
    const first = await migrateOne(path, { out, validateOnly: false, force: false }, undefined);
    expect(first.error).toBeUndefined();
    const second = await migrateOne(path, { out, validateOnly: false, force: false }, undefined);
    expect(second.error).toContain("refusing to overwrite");
    const forced = await migrateOne(path, { out, validateOnly: false, force: true }, undefined);
    expect(forced.error).toBeUndefined();
    expect(forced.files).toHaveLength(3);
  });

  test("the human summary lists flagged constructs and the smoke result", async () => {
    const path = await writeModel("summary.json", unmappedModel("summary-run"));
    const result = await runMigrate([path], { out: join(pkgTmp, "out-sum"), validateOnly: false, force: false });
    const text = formatMigrateReport(result, false);
    expect(text).toContain("translated: 3, flagged: 1");
    expect(text).toContain("⚑ effect 'place-order'");
    expect(text).toContain("compile smoke passed");
  });
});

describe("tdk migrate — the CLI exit-code contract", () => {
  test("--validate-only on a valid model exits 0", async () => {
    const path = await writeModel("cli-valid.json", unmappedModel("cli-valid"));
    const { code, stdout } = await runCli(["migrate", path, "--validate-only"]);
    expect(code).toBe(0);
    expect(stdout).toContain("valid");
  }, 30_000);

  test("--validate-only on an invalid model exits 1 with the error on stderr", async () => {
    const bad = {
      modelVersion: "1",
      template: { id: "b", title: "B" },
      questions: [{ name: "f", type: "string", page: "P", visibleWhen: { field: "nope", is: "x" } }],
    };
    const path = await writeModel("cli-bad.json", bad);
    const { code, stderr } = await runCli(["migrate", path, "--validate-only"]);
    expect(code).toBe(1);
    expect(stderr).toContain("visibleWhen.field");
  }, 30_000);

  test("--json emits a machine-readable report", async () => {
    const path = await writeModel("cli-json.json", unmappedModel("cli-json"));
    const { code, stdout } = await runCli(["migrate", path, "--validate-only", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).models[0].templateId).toBe("cli-json");
  }, 30_000);
});
