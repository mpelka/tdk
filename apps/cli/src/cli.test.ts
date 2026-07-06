// SMOKE suite for the `tdk` CLI — spawns the real `src/cli.ts` bin as a subprocess
// (via `bun run`) against the self-contained `__fixtures__/greeting` template and
// asserts on stdout / stderr / exit code / on-disk writes. This is deliberately
// SLIM: it pins exactly the CONSUMER CONTRACT the VS Code extension and
// coding-agent loops depend on (one per command's happy path, the compile-error
// stderr format, the byte-for-byte `--json` shapes + trailing newline, `--list`
// side-effect-freedom, the `-u`×`--ci` conflict, and init end-to-end). The bulk
// of the behavior — the compile/build/execute/test/init operations and error
// formatting — is unit-tested DIRECTLY in `src/lib/*.test.ts` (imported, no
// subprocess), which is faster and far more instrumentable.
//
// Scaffolded/mutated fixtures live in a `.tmp-test-*` dir INSIDE the package (not
// the OS tmpdir) so their `@tdk/core` imports resolve through the workspace's
// node_modules; the dot-prefix keeps them out of `tdk test`'s discovery glob. The
// OS tmpdir is only used for cwd isolation and `-o` writes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.ts");
const GREETING_DIR = join(here, "__fixtures__", "greeting");
const TEMPLATE = join(GREETING_DIR, "template.ts");
const SCENARIOS = join(GREETING_DIR, "__fixtures__", "scenarios.ts");
const CONFIG = join(here, "__fixtures__", "tdk.config.ts");

// Every test in this file spawns >=1 real `bun run cli.ts` subprocess (see
// `runCli` below). Standalone, spawn+import comfortably clears bun's 5s
// default per-test timeout. Under the FULL WORKSPACE suite (~750 tests across
// many files run in parallel), CPU/scheduler contention can inflate that
// spawn+import cost past 5s even for a single subprocess call, independent of
// this file's own test count — bun's default timeout is tuned for in-process
// assertions, not for shelling out under load. Give every test here the same
// generous ceiling rather than tuning each one individually, since the
// bottleneck is subprocess scheduling, not test logic. See #33.
const SUBPROCESS_TIMEOUT = 30_000;

/** A template whose compiled entity FAILS the Backstage schema (owner: 42). */
const INVALID_TEMPLATE = `import { defineTemplate, p, step } from "@tdk/core";
export default defineTemplate({
  id: "bad-fixture",
  title: "Bad",
  description: "d",
  type: "service",
  parameters: { who: p.string({ title: "Who" }) },
  owner: 42 as unknown as string,
  steps: () => [step("greet", "debug:log", { name: "G", input: {} })],
});
`;

/** Run the CLI with `args`, optional stdin, returning stdout/stderr/exit. */
async function runCli(
  args: string[],
  opts: { stdin?: string; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: opts.cwd ?? here,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { stdout, stderr, code };
}

let tmp: string;
/** Scratch INSIDE the package, so scaffolded templates can import @tdk/core. */
let pkgTmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tdk-cli-test-"));
  pkgTmp = await mkdtemp(join(here, "..", ".tmp-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await rm(pkgTmp, { recursive: true, force: true });
});

/**
 * Scaffold a testable template dir under `pkgTmp` — a copy of the greeting
 * fixture by default; `template`/`scenarios` override the file contents.
 */
async function scaffoldTemplate(name: string, opts: { template?: string; scenarios?: string } = {}): Promise<string> {
  const dir = join(pkgTmp, name);
  await mkdir(join(dir, "__fixtures__"), { recursive: true });
  await writeFile(join(dir, "template.ts"), opts.template ?? (await readFile(TEMPLATE, "utf8")), "utf8");
  await writeFile(
    join(dir, "__fixtures__", "scenarios.ts"),
    opts.scenarios ?? (await readFile(SCENARIOS, "utf8")),
    "utf8",
  );
  return dir;
}

describe("compile — happy path + error contract", () => {
  test(
    "compiles ONE template to stdout (default test env), exit 0",
    async () => {
      const { stdout, code } = await runCli(["compile", TEMPLATE]);
      expect(code).toBe(0);
      expect(stdout).toContain("kind: Template");
      expect(stdout).toContain("name: cake-order-fixture");
      // env.pick resolves to the test value by default.
      expect(stdout).toContain("cluster: test-cluster");
      expect(stdout).not.toContain("prod-cluster");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a schema-invalid template fails compile by default (exit 1)",
    async () => {
      const dir = join(pkgTmp, "compile-invalid");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "template.ts"), INVALID_TEMPLATE, "utf8");
      const { stderr, code } = await runCli(["compile", join(dir, "template.ts")]);
      expect(code).toBe(1);
      expect(stderr).toContain("failed schema validation");
      expect(stderr).toContain("/spec/owner");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a single build error reaches stderr as file:line:col: message",
    async () => {
      // Bun throws a bare BuildMessage (NOT an AggregateError) for exactly one
      // build error — the position must not be lost.
      const broken = join(pkgTmp, "broken-syntax.ts");
      await writeFile(broken, "const x =\n", "utf8");
      const { stderr, code } = await runCli(["compile", broken]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/broken-syntax\.ts:1:\d+: /);
      expect(stderr).toContain("Unexpected");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "--stdin errors are remapped from the temp file to the ORIGINAL path",
    async () => {
      // NB: keep this buffer invalid on EVERY Bun — stable and canary disagree
      // on some incomplete-statement forms (`const x =\n` imports cleanly on
      // stable, which turns this into a "No template found" error instead).
      const { stderr, code } = await runCli(["compile", "--stdin", TEMPLATE], { stdin: "const x: = 1;\n" });
      expect(code).toBe(1);
      expect(stderr).toMatch(/greeting[\\/]template\.ts:1:\d+/);
      expect(stderr).not.toContain(".tdk-compile-");
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("build — happy path", () => {
  test(
    "--stdout prints every artifact separated by --- (no disk write)",
    async () => {
      const { stdout, code } = await runCli(["build", CONFIG, "--stdout"]);
      expect(code).toBe(0);
      // One artifact per target (nonprod=test, prod=prod), joined by a YAML doc marker.
      const docs = stdout.split(/^---$/m);
      expect(docs.length).toBe(2);
      expect(stdout).toContain("cluster: test-cluster");
      expect(stdout).toContain("cluster: prod-cluster");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "--watch and --stdout cannot be combined (exit 1); build --help advertises --watch",
    async () => {
      const conflict = await runCli(["build", CONFIG, "--watch", "--stdout"]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr).toContain("cannot be used with option");
      const help = await runCli(["build", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toContain("--watch");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "writes artifacts RELATIVE TO THE CONFIG FILE, not the cwd",
    async () => {
      const dir = await scaffoldTemplate("build-write");
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
      // Run from a DIFFERENT cwd — artifacts must still land next to the config.
      const { code, stdout } = await runCli(["build", "-c", join(dir, "tdk.config.ts")], { cwd: tmp });
      expect(code).toBe(0);
      expect(stdout).toContain("Compiled 2 artifact(s)");
      const nonprod = await readFile(join(dir, "out-nonprod", "cake-order-fixture", "template.yaml"), "utf8");
      expect(nonprod).toContain("cluster: test-cluster");
      // Nothing leaked into the cwd.
      expect(await Bun.file(join(tmp, "out-nonprod", "cake-order-fixture", "template.yaml")).exists()).toBe(false);
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("execute — the --json contract shape", () => {
  test(
    "prints ONE { ok, scenarios } object with a trailing newline (default test env)",
    async () => {
      const { stdout, code } = await runCli(["execute", TEMPLATE, "--json"]);
      expect(code).toBe(0);
      expect(stdout.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(stdout) as {
        ok: boolean;
        scenarios: Array<{ name: string; result?: { steps: Record<string, { input: { cluster: string } }> } }>;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.scenarios).toHaveLength(1);
      expect(parsed.scenarios[0]!.name).toBe("orders for alice");
      expect(parsed.scenarios[0]!.result!.steps.order!.input.cluster).toBe("test-cluster");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a scenarios file that fails to load is a HARD error (not zero scenarios)",
    async () => {
      const dir = await scaffoldTemplate("execute-broken-scenarios", { scenarios: "const x =\n" });
      const { stderr, code } = await runCli(["execute", join(dir, "template.ts")]);
      expect(code).toBe(1);
      expect(stderr).toContain("scenarios.ts");
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("test — the snapshot + --json + --list contracts", () => {
  test(
    "first run WRITES the snapshot, second run PASSES, --ci passes after",
    async () => {
      const dir = await scaffoldTemplate("snap-write-pass");
      const snapPath = join(dir, "__snapshots__", "scenarios.snap");

      const first = await runCli(["test", dir]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain("(written)");
      expect(await Bun.file(snapPath).exists()).toBe(true);

      const second = await runCli(["test", dir]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("✓ orders for alice");
      expect(second.stdout).toContain("1 passed");

      const ci = await runCli(["test", dir, "--ci"]);
      expect(ci.code).toBe(0);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a changed scenario MISMATCHES (exit 1, diff, snapshot preserved); -u accepts",
    async () => {
      const dir = await scaffoldTemplate("snap-mismatch");
      const snapPath = join(dir, "__snapshots__", "scenarios.snap");
      expect((await runCli(["test", dir])).code).toBe(0); // write baseline
      const baseline = await readFile(snapPath, "utf8");

      // Change the scenario input → the fresh result no longer matches. A fresh
      // subprocess re-imports the mutated fixture (no stale module cache).
      const scenarios = await readFile(SCENARIOS, "utf8");
      await writeFile(
        join(dir, "__fixtures__", "scenarios.ts"),
        scenarios.replace('customer: "Alice"', 'customer: "Bob"'),
        "utf8",
      );

      const mismatch = await runCli(["test", dir]);
      expect(mismatch.code).toBe(1);
      expect(mismatch.stdout).toContain("Expected:");
      expect(mismatch.stdout).toContain("Received:");
      expect(mismatch.stdout).toContain("1 failed");
      // A normal run never rewrites the stored snapshot.
      expect(await readFile(snapPath, "utf8")).toBe(baseline);

      const update = await runCli(["test", dir, "-u"]);
      expect(update.code).toBe(0);
      expect(update.stdout).toContain("(updated)");
      expect(await readFile(snapPath, "utf8")).toContain("Order for Bob!");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "--json emits { templates } with per-scenario statuses + a trailing newline",
    async () => {
      const dir = await scaffoldTemplate("snap-json");
      const first = await runCli(["test", dir, "--json"]);
      expect(first.code).toBe(0);
      expect(first.stdout.endsWith("\n")).toBe(true);
      const parsedFirst = JSON.parse(first.stdout) as {
        templates: Array<{ path: string; ok: boolean; scenarios: Array<{ name: string; status: string }> }>;
      };
      expect(parsedFirst.templates).toHaveLength(1);
      expect(parsedFirst.templates[0]!.path).toBe("template.ts");
      expect(parsedFirst.templates[0]!.scenarios[0]).toMatchObject({ name: "orders for alice", status: "written" });

      const second = await runCli(["test", dir, "--json"]);
      const parsedSecond = JSON.parse(second.stdout) as {
        templates: Array<{ scenarios: Array<{ status: string; result?: unknown }> }>;
      };
      expect(parsedSecond.templates[0]!.scenarios[0]!.status).toBe("passed");
      expect(parsedSecond.templates[0]!.scenarios[0]!.result).toBeDefined();
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a per-scenario execute() throw sets status failed with a distinct error (mirrored into actual)",
    async () => {
      const dir = await scaffoldTemplate("snap-scenario-error", {
        scenarios: `export const scenarios = [
  { name: "good", fixture: { parameters: { who: "A" }, steps: { greet: { output: {} } } } },
  { name: "broken", fixture: undefined },
];
`,
      });
      const { stdout, code } = await runCli(["test", dir, "--json"]);
      expect(code).toBe(1);
      const parsed = JSON.parse(stdout) as {
        templates: Array<{ scenarios: Array<{ name: string; status: string; error?: string; actual?: string }> }>;
      };
      const broken = parsed.templates[0]!.scenarios.find((s) => s.name === "broken")!;
      expect(broken.status).toBe("failed");
      expect(typeof broken.error).toBe("string");
      // `actual` mirrors `error` for one release (old readers).
      expect(broken.actual).toBe(broken.error!);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "--list lists templates + scenario names as JSON without executing or touching snapshots",
    async () => {
      const dir = await scaffoldTemplate("list-basic");
      const { stdout, code } = await runCli(["test", dir, "--list"]);
      expect(code).toBe(0);
      expect(stdout.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(stdout) as {
        templates: Array<{ path: string; ok: boolean; scenarios: Array<{ name: string; branches?: string[] }> }>;
      };
      expect(parsed.templates).toEqual([
        { path: "template.ts", ok: true, scenarios: [{ name: "orders for alice", branches: ["default"] }] },
      ]);
      // No snapshot IO happened (side-effect-free).
      expect(await Bun.file(join(dir, "__snapshots__", "scenarios.snap")).exists()).toBe(false);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "the committed greeting baseline passes under --ci",
    async () => {
      const { stdout, code } = await runCli(["test", GREETING_DIR, "--ci"]);
      expect(code).toBe(0);
      expect(stdout).toContain("1 passed");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "-u and --ci cannot be combined (exit 1)",
    async () => {
      const { stderr, code } = await runCli(["test", GREETING_DIR, "-u", "--ci"]);
      expect(code).toBe(1);
      expect(stderr).toContain("cannot be used with option '--ci'");
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("init — scaffold end-to-end", () => {
  test(
    "scaffolds a testable template + config + first snapshot; refuses to overwrite",
    async () => {
      const dir = join(pkgTmp, "init-here");
      const first = await runCli(["init", dir]);
      expect(first.code).toBe(0);
      for (const f of ["template.ts", join("__fixtures__", "scenarios.ts"), "tdk.config.ts"]) {
        expect(await Bun.file(join(dir, f)).exists()).toBe(true);
      }
      expect(await Bun.file(join(dir, "__snapshots__", "scenarios.snap")).exists()).toBe(true);

      // The scaffold is immediately green under --ci.
      const ci = await runCli(["test", dir, "--ci"]);
      expect(ci.code).toBe(0);

      // A second init refuses to overwrite.
      const second = await runCli(["init", dir]);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain("refusing to overwrite");
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("bare / help / version / unknown", () => {
  test(
    "bare tdk prints usage to stdout and exits 0 with no stderr",
    async () => {
      const { stdout, stderr, code } = await runCli([]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      // Commander-generated help still names every command + --version.
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("compile");
      expect(stdout).toContain("build");
      expect(stdout).toContain("execute");
      expect(stdout).toContain("test");
      expect(stdout).toContain("init");
      expect(stdout).toContain("--version");
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "--version prints the package version (exit 0)",
    async () => {
      const { stdout, code } = await runCli(["--version"]);
      expect(code).toBe(0);
      expect(stdout).toMatch(/^tdk \d+\.\d+\.\d+\n$/);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "execute's help does not advertise --json, but the flag is still accepted",
    async () => {
      const help = await runCli(["execute", "--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).not.toContain("--json");
      const withFlag = await runCli(["execute", TEMPLATE, "--json"]);
      expect(withFlag.code).toBe(0);
      expect(JSON.parse(withFlag.stdout).ok).toBe(true);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "an unknown flag exits 1",
    async () => {
      const { code } = await runCli(["execute", TEMPLATE, "--frobnicate"]);
      expect(code).toBe(1);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "an unknown command exits 1",
    async () => {
      const { code } = await runCli(["frobnicate"]);
      expect(code).toBe(1);
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "a value-flag refuses a flag-looking value and writes NOTHING",
    async () => {
      // Commander's default would consume "--env" as -o's value and write a
      // file literally named "--env" with exit 0 — the silent-write regression
      // the pathValue guard exists to prevent.
      const cwd = await mkdtemp(join(tmpdir(), "tdk-flagval-"));
      const { stderr, code } = await runCli(["compile", TEMPLATE, "-o", "--env"], { cwd });
      expect(code).toBe(1);
      expect(stderr).toContain("requires a value");
      expect(await readdir(cwd)).toEqual([]);
      await rm(cwd, { recursive: true, force: true });
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "short-flag = forms work: -o=path writes that path, -e=prod picks prod",
    async () => {
      const outPath = join(tmp, "short-eq.yaml");
      const wrote = await runCli(["compile", TEMPLATE, `-o=${outPath}`]);
      expect(wrote.code).toBe(0);
      expect(await readFile(outPath, "utf8")).toContain("kind: Template");
      const prod = await runCli(["compile", TEMPLATE, "-e=prod"]);
      expect(prod.code).toBe(0);
      expect(prod.stdout).toContain("cluster: prod-cluster");
    },
    SUBPROCESS_TIMEOUT,
  );
});
