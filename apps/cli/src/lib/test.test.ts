// Direct unit tests for the `tdk test` snapshot engine — discovery, target
// resolution, the `--list` side-effect-free path, per-template snapshot
// reconciliation (write / pass / mismatch / update / --ci-miss), duplicate-name
// detection, corrupt-snap per-suite failure, obsolete pruning, and the loud
// failure paths. All by importing the functions; no subprocess.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePkgTmp, scaffoldTemplate } from "./__fixtures__/scaffold.ts";
import {
  anyFailure,
  deepEqual,
  discoverTestableTemplates,
  formatTestReport,
  listScenarios,
  resolveTestTargets,
  runTemplateTest,
  runTests,
  serializeTestReports,
  snapshotPath,
} from "./test.ts";

let pkgTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
});

const RUN = { update: false, ci: false } as const;

describe("resolveTestTargets", () => {
  test("a nonexistent path throws `tdk test: path not found` (no raw ENOENT)", async () => {
    const err = await resolveTestTargets(join(pkgTmp, "does", "not", "exist")).catch((e) => e as Error);
    expect((err as Error).message).toContain("tdk test: path not found:");
    expect((err as Error).message).not.toContain("ENOENT");
  });

  test("a single template.ts file resolves to just itself (root = its dir)", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "resolve-file");
    const { root, templates, empty } = await resolveTestTargets(join(dir, "template.ts"));
    expect(empty).toBe(false);
    expect(root).toBe(dir);
    expect(templates).toEqual([join(dir, "template.ts")]);
  });

  test("a directory globs for testable templates; empty flags `empty`", async () => {
    const empty = join(pkgTmp, "resolve-empty");
    await Bun.write(join(empty, "placeholder.txt"), "");
    const resolved = await resolveTestTargets(empty);
    expect(resolved.empty).toBe(true);
    expect(resolved.templates).toEqual([]);
  });
});

describe("discoverTestableTemplates", () => {
  test("finds a dir with BOTH template.ts and __fixtures__/scenarios.ts", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "discover-one");
    const found = await discoverTestableTemplates(dir);
    expect(found).toEqual([join(dir, "template.ts")]);
  });

  test("ignores a scenarios file without a sibling template.ts", async () => {
    const dir = join(pkgTmp, "discover-orphan");
    await Bun.write(join(dir, "__fixtures__", "scenarios.ts"), "export const scenarios = [];\n");
    expect(await discoverTestableTemplates(dir)).toEqual([]);
  });
});

describe("listScenarios (--list, side-effect-free)", () => {
  test("lists templates + scenario names + branches without touching snapshots", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "list-basic");
    const result = await listScenarios([join(dir, "template.ts")], dir);
    expect(result.anyFailed).toBe(false);
    expect(result.templates).toEqual([
      { path: "template.ts", ok: true, scenarios: [{ name: "orders for alice", branches: ["default"] }] },
    ]);
    // No snapshot IO happened.
    expect(existsSync(snapshotPath(join(dir, "template.ts")))).toBe(false);
  });

  test("a scenarios file that fails to load is ok:false and flips anyFailed", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "list-broken", { scenarios: "const x =\n" });
    const result = await listScenarios([join(dir, "template.ts")], dir);
    expect(result.anyFailed).toBe(true);
    expect(result.templates[0]!.ok).toBe(false);
    expect(result.templates[0]!.error).toContain("scenarios.ts");
  });
});

describe("runTemplateTest — snapshot reconciliation", () => {
  test("first run WRITES, second run PASSES, --ci passes after", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-write-pass");
    const tpl = join(dir, "template.ts");

    const first = await runTemplateTest(tpl, dir, RUN);
    expect(first.ok).toBe(true);
    expect(first.scenarios[0]!.status).toBe("written");
    expect(existsSync(snapshotPath(tpl))).toBe(true);

    const second = await runTemplateTest(tpl, dir, RUN);
    expect(second.scenarios[0]!.status).toBe("passed");
    expect(second.scenarios[0]!.result).toBeDefined();

    const ci = await runTemplateTest(tpl, dir, { update: false, ci: true });
    expect(ci.scenarios[0]!.status).toBe("passed");
  });

  test("a mismatch FAILS with expected/actual and PRESERVES the snapshot; -u accepts", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-mismatch");
    const tpl = join(dir, "template.ts");
    await runTemplateTest(tpl, dir, RUN); // write baseline

    // Tamper the STORED snapshot so the fresh result no longer matches it — this
    // exercises the same mismatch path as changing the scenario, but without
    // re-importing a fixture (Bun caches modules by resolved path, so a rewritten
    // scenarios.ts would return stale content within one process; the subprocess
    // smoke test in cli.test.ts covers the change-the-scenario route).
    const tampered = (await readFile(snapshotPath(tpl), "utf8")).replace(/Order for Alice!/g, "Order for Bob!");
    await writeFile(snapshotPath(tpl), tampered, "utf8");

    const mismatch = await runTemplateTest(tpl, dir, RUN);
    expect(mismatch.scenarios[0]!.status).toBe("failed");
    expect(mismatch.scenarios[0]!.expected).toBeDefined();
    expect(mismatch.scenarios[0]!.actual).toBeDefined();
    // A normal run never rewrites the stored (tampered) snapshot.
    expect(await readFile(snapshotPath(tpl), "utf8")).toBe(tampered);

    // -u accepts the fresh result → the real "Order for Alice!" is written back.
    const update = await runTemplateTest(tpl, dir, { update: true, ci: false });
    expect(update.scenarios[0]!.status).toBe("updated");
    expect(await readFile(snapshotPath(tpl), "utf8")).toContain("Order for Alice!");

    const after = await runTemplateTest(tpl, dir, RUN);
    expect(after.scenarios[0]!.status).toBe("passed");
  });

  test("--ci FAILS on a missing snapshot and NEVER writes", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-ci-missing");
    const tpl = join(dir, "template.ts");
    const report = await runTemplateTest(tpl, dir, { update: false, ci: true });
    expect(report.scenarios[0]!.status).toBe("failed");
    expect(existsSync(snapshotPath(tpl))).toBe(false);
  });

  test("obsolete entries are reported on a normal run and PRUNED under -u", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-obsolete");
    const tpl = join(dir, "template.ts");
    await runTemplateTest(tpl, dir, RUN); // write baseline
    await writeFile(snapshotPath(tpl), `${await readFile(snapshotPath(tpl), "utf8")}stale entry: {}\n`, "utf8");

    const warn = await runTemplateTest(tpl, dir, RUN);
    expect(warn.ok).toBe(true); // obsolete alone is not a failure
    expect(warn.obsolete).toContain("stale entry");

    const update = await runTemplateTest(tpl, dir, { update: true, ci: false });
    expect(update.obsolete).toContain("stale entry");
    expect(await readFile(snapshotPath(tpl), "utf8")).not.toContain("stale entry");
  });

  test("a per-scenario execute() throw reports failed with a distinct error (mirrored into actual)", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-scenario-error", {
      scenarios: `export const scenarios = [
  { name: "good", fixture: { parameters: { who: "A" }, steps: { greet: { output: {} } } } },
  { name: "broken", fixture: undefined },
];
`,
    });
    const report = await runTemplateTest(join(dir, "template.ts"), dir, RUN);
    const broken = report.scenarios.find((s) => s.name === "broken")!;
    expect(broken.status).toBe("failed");
    expect(typeof broken.error).toBe("string");
    // `actual` mirrors `error` for one release (old readers).
    expect(broken.actual).toBe(broken.error!);
  });

  test("a scenarios file with the WRONG export name fails the suite", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-wrong-export", { scenarios: "export const scenario = [];\n" });
    const report = await runTemplateTest(join(dir, "template.ts"), dir, { update: false, ci: true });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("does not export a `scenarios` array");
    expect(report.error).toContain('did you mean "scenarios"');
  });

  test("a scenarios file with a SYNTAX error fails the suite naming the file", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-syntax", { scenarios: "const x =\n" });
    const report = await runTemplateTest(join(dir, "template.ts"), dir, { update: false, ci: true });
    expect(report.ok).toBe(false);
    expect(report.error).toContain("Failed to load");
    expect(report.error).toMatch(/scenarios\.ts:1:\d+/);
  });

  test("a corrupt snapshot file fails ONLY that suite, naming the snap path", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-corrupt");
    const tpl = join(dir, "template.ts");
    // Bun.write creates the __snapshots__ dir as needed.
    await Bun.write(snapshotPath(tpl), "good: {bad yaml: [unclosed\n");
    const report = await runTemplateTest(tpl, dir, RUN);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("Corrupt snapshot file");
    expect(report.error).toContain(join("__snapshots__", "scenarios.snap"));
  });

  test("duplicate scenario names fail with the duplicate listed", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "snap-duplicates", {
      scenarios: `export const scenarios = [
  { name: "same", fixture: { parameters: { who: "A" }, steps: { greet: { output: {} } } } },
  { name: "same", fixture: { parameters: { who: "B" }, steps: { greet: { output: {} } } } },
];
`,
    });
    const report = await runTemplateTest(join(dir, "template.ts"), dir, RUN);
    expect(report.ok).toBe(false);
    expect(report.error).toContain("Duplicate scenario name(s)");
    expect(report.error).toContain('"same"');
  });
});

describe("runTests + anyFailure", () => {
  test("runs every discovered template and reports timing", async () => {
    const dir = await scaffoldTemplate(pkgTmp, "run-all");
    const { reports, ms } = await runTests([join(dir, "template.ts")], dir, RUN);
    expect(reports).toHaveLength(1);
    expect(typeof ms).toBe("number");
    expect(anyFailure(reports)).toBe(false); // first run writes — not a failure
  });

  test("anyFailure is true when a suite fails to load", () => {
    expect(anyFailure([{ path: "x", ok: false, scenarios: [] }])).toBe(true);
  });

  test("anyFailure is true when a scenario is `failed`", () => {
    expect(anyFailure([{ path: "x", ok: true, scenarios: [{ name: "s", status: "failed" }] }])).toBe(true);
  });
});

describe("serializeTestReports", () => {
  test("emits { templates } with a trailing newline", () => {
    const out = serializeTestReports([{ path: "template.ts", ok: true, scenarios: [] }]);
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ templates: [{ path: "template.ts", ok: true, scenarios: [] }] });
  });
});

describe("formatTestReport (human-readable)", () => {
  test("renders the ✓/+/↻/✗ markers and a summary (no ANSI when tty=false)", () => {
    const out = formatTestReport(
      [
        {
          path: "a/template.ts",
          ok: true,
          scenarios: [
            { name: "passes", status: "passed" },
            { name: "fresh", status: "written" },
            { name: "accepted", status: "updated" },
          ],
        },
      ],
      12,
      false,
    );
    expect(out).toContain("✓ passes");
    expect(out).toContain("+ fresh (written)");
    expect(out).toContain("↻ accepted (updated)");
    expect(out).toContain("Done in 12ms");
    expect(out).not.toContain("\x1b["); // no color without a TTY
  });

  test("renders an expected/received diff block for a mismatch", () => {
    const out = formatTestReport(
      [{ path: "t", ok: true, scenarios: [{ name: "m", status: "failed", expected: "a: 1", actual: "a: 2" }] }],
      1,
      false,
    );
    expect(out).toContain("Expected:");
    expect(out).toContain("Received:");
    expect(out).toContain("1 failed");
  });
});

describe("deepEqual", () => {
  test("is key-order independent for objects", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  test("distinguishes arrays from objects and differing lengths", () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
  });
});
