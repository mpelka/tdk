// Direct unit tests for the `tdk build --watch` lib. Import the functions and
// assert on their RETURNED data / captured emit / on-disk effects. The pure
// pieces (`shouldTrigger`, the output-dir resolution) are tested standalone; the
// debounce, close, and error-survival paths inject a FAKE `runBuild` (no real
// subprocess) so they are fast and deterministic; one end-to-end cycle uses the
// REAL subprocess runner over a scaffolded in-package temp dir (so the child's
// `@tdk/core` imports resolve and an edit is genuinely picked up).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makePkgTmp, scaffoldTemplate } from "./__fixtures__/scaffold.ts";
import {
  type BuildRunner,
  DEFAULT_DEBOUNCE_MS,
  outputDirsFromConfig,
  shouldTrigger,
  startWatch,
  type WatchEmit,
  type WatchMessage,
} from "./watch.ts";

// Every test below that waits on a REAL `fs.watch` event or spawns the REAL
// subprocess build (the debounce, error-survival, close, and end-to-end
// suites) is exercising genuine OS scheduling, not in-process logic.
// Standalone, that latency comfortably clears bun's 5s default per-test
// timeout. Under the FULL WORKSPACE suite (~750+ tests across many files run
// in parallel), CPU/scheduler contention can inflate fs.watch delivery and
// subprocess spawn+import cost past 5s independent of this file's own test
// count — the same failure class as the subprocess contention in
// `cli.test.ts` (#33). Give every timing-sensitive test here the same
// generous ceiling rather than tuning each one individually. See #47.
const SUBPROCESS_TIMEOUT = 30_000;

let pkgTmp: string;
let osTmp: string;
beforeAll(async () => {
  pkgTmp = await makePkgTmp();
  osTmp = await mkdtemp(join(tmpdir(), "tdk-lib-watch-"));
});
afterAll(async () => {
  await rm(pkgTmp, { recursive: true, force: true });
  await rm(osTmp, { recursive: true, force: true });
});

/** A tdk.config that fans one template out to a nonprod + prod target. */
function configFor(): string {
  return `import { defineConfig } from "@tdk/core";
import CakeOrder from "./template.ts";
export default defineConfig({
  templates: [CakeOrder],
  targets: {
    nonprod: { env: "test", outDir: "./out-nonprod" },
    prod: { env: "prod", outDir: "./out-prod" },
  },
});
`;
}

describe("shouldTrigger — the ignore filter", () => {
  const dir = resolve("/watch-root");
  const outNonprod = join(dir, "out-nonprod");
  const outs = [outNonprod, join(dir, "out-prod")];

  test("a plain .ts file under the tree triggers", () => {
    expect(shouldTrigger(join(dir, "template.ts"), dir, outs)).toBe(true);
    expect(shouldTrigger(join(dir, "lib", "helper.ts"), dir, outs)).toBe(true);
  });

  test("a non-.ts change never triggers", () => {
    expect(shouldTrigger(join(dir, "template.yaml"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, "README.md"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, "notes.txt"), dir, outs)).toBe(false);
    // A non-.ts file's atomic-save temp must not trigger either.
    expect(shouldTrigger(join(dir, "notes.txt.new"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, "data.json~"), dir, outs)).toBe(false);
  });

  test("an editor's atomic-save decoration of a .ts file triggers (mv/sed/vim rename-into-place)", () => {
    // macOS fs.watch reports a rename-into-place against the TEMP name, so these
    // decorations of a `.ts` save must still trigger a rebuild.
    for (const name of [
      "template.ts.new",
      "template.ts.tmp",
      "template.ts~",
      "template.ts.a1b2",
      "template.ts.12345",
    ]) {
      expect(shouldTrigger(join(dir, name), dir, outs)).toBe(true);
    }
    // A dot-prefixed vim swap is NOT a real save — the dotfile rule drops it.
    expect(shouldTrigger(join(dir, ".template.ts.swp"), dir, outs)).toBe(false);
  });

  test("anything under an output dir is ignored (our own write)", () => {
    expect(shouldTrigger(join(outNonprod, "cake-order-fixture", "template.ts"), dir, outs)).toBe(false);
    // The output dir itself, and a sibling that merely shares a prefix, differ.
    expect(shouldTrigger(outNonprod, dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, "out-nonprod-extra", "x.ts"), dir, outs)).toBe(true);
  });

  test("node_modules, __snapshots__, and dotdirs are ignored at any depth", () => {
    expect(shouldTrigger(join(dir, "node_modules", "pkg", "index.ts"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, "__snapshots__", "scenarios.ts"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, ".git", "hooks", "x.ts"), dir, outs)).toBe(false);
    expect(shouldTrigger(join(dir, ".tmp-libtest-abc", "template.ts"), dir, outs)).toBe(false);
    // A dot-prefixed FILE is also out.
    expect(shouldTrigger(join(dir, ".hidden.ts"), dir, outs)).toBe(false);
  });

  test("a path outside the watched tree (or the dir itself) never triggers", () => {
    expect(shouldTrigger(dir, dir, outs)).toBe(false);
    expect(shouldTrigger(resolve(dir, "..", "sibling", "x.ts"), dir, outs)).toBe(false);
  });
});

describe("outputDirsFromConfig", () => {
  const configDir = resolve("/proj");

  test("resolves each target's outDir against the config dir", () => {
    const config = {
      templates: [],
      targets: {
        nonprod: { env: "test", outDir: "./dist/nonprod" },
        prod: { env: "prod", outDir: "../shared/prod" },
      },
    } as never;
    expect(outputDirsFromConfig(config, configDir).sort()).toEqual(
      [join(configDir, "dist", "nonprod"), resolve(configDir, "..", "shared", "prod")].sort(),
    );
  });

  test("a target with no outDir (out-based) contributes no static dir; malformed config is empty", () => {
    const outBased = { templates: [], targets: { x: { env: "test", out: () => "y.yaml" } } } as never;
    expect(outputDirsFromConfig(outBased, configDir)).toEqual([]);
    expect(outputDirsFromConfig(undefined, configDir)).toEqual([]);
    expect(outputDirsFromConfig({} as never, configDir)).toEqual([]);
  });
});

describe("debounce — a burst of changes collapses to one rebuild", () => {
  test("the default window is 150ms", () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(150);
  });

  test(
    "many rapid .ts saves fire exactly one extra cycle via a controllable timer",
    async () => {
      const dir = await scaffoldTemplate(pkgTmp, "watch-debounce");
      await writeFile(join(dir, "tdk.config.ts"), configFor(), "utf8");
      const configPath = join(dir, "tdk.config.ts");

      // A controllable fake timer. Each `schedule()` clears the prior arm and sets a
      // new one, so only the LAST-armed callback survives — that is the debounce.
      // `queued` always holds the single live callback; firing it runs one cycle.
      let queued: (() => void) | undefined;
      const setTimer = (fn: () => void) => {
        queued = fn;
        return {};
      };
      const clearTimer = () => {
        queued = undefined;
      };

      const { runBuild, calls } = countingRunner();
      const messages: WatchMessage[] = [];
      const handle = startWatch(configPath, (m) => messages.push(m), { setTimer, clearTimer, runBuild });
      try {
        await handle.nextCycle(); // the immediate initial build
        expect(headers(messages)).toBe(1);
        expect(calls()).toBe(1);

        // Rapid saves — each surviving event triggers a `schedule()`, re-arming the
        // fake timer. Re-poke until at least one event has armed the debounce (a
        // single macOS event can drop under load, and under full-suite scheduler
        // contention the arm can take much longer than it does standalone); the
        // fake timer collapses however many arrive into ONE live callback.
        const start = Date.now();
        let v = 0;
        while (typeof queued !== "function") {
          if (Date.now() - start > SUBPROCESS_TIMEOUT / 2) throw new Error("no fs event armed the debounce");
          await writeFile(join(dir, "helper.ts"), `export const v = ${v++};\n`, "utf8");
          await utimes(join(dir, "helper.ts"), new Date(), new Date());
          await Bun.sleep(150);
        }
        expect(typeof queued).toBe("function"); // exactly one live debounce callback

        // Fire the single armed callback → exactly one rebuild for the whole burst.
        const next = handle.nextCycle();
        queued?.();
        await next;
        expect(headers(messages)).toBe(2);
        expect(calls()).toBe(2);
      } finally {
        handle.close();
      }
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("startWatch — cycle behaviour with an injected runner", () => {
  test(
    "a failing build (non-zero exit) is reported and the watcher survives it",
    async () => {
      const dir = await scaffoldTemplate(pkgTmp, "watch-survives-error");
      await writeFile(join(dir, "tdk.config.ts"), configFor(), "utf8");
      const configPath = join(dir, "tdk.config.ts");

      // First cycle fails (exit 1, stderr), the next succeeds — proving the watcher
      // lives through a failure and retries on the next save.
      let cycle = 0;
      const runBuild: BuildRunner = async (_config, emit) => {
        cycle += 1;
        if (cycle === 1) {
          emit({ stream: "err", text: "template.ts:1:1: Unexpected end of file\n" });
          return 1;
        }
        emit({ stream: "out", text: "\nCompiled 2 artifact(s).\n" });
        return 0;
      };

      const messages: WatchMessage[] = [];
      const handle = startWatch(configPath, (m) => messages.push(m), { debounceMs: 20, runBuild });
      try {
        await handle.nextCycle(); // the failing initial build
        expect(messages.some((m) => m.stream === "err" && m.text.includes("Unexpected"))).toBe(true);
        expect(messages.some((m) => m.text.includes("build exited with code 1"))).toBe(true);

        // A save triggers the second (green) cycle — the watcher survived. Re-poke
        // until it lands: a single macOS fs.watch event can be dropped under load,
        // and the survival contract (not the delivery of one specific event) is
        // what this asserts.
        await pokeUntil(handle, messages, dir, 2);
        expect(messages.some((m) => m.text.includes("Compiled 2 artifact(s)"))).toBe(true);
      } finally {
        handle.close();
      }
    },
    SUBPROCESS_TIMEOUT,
  );

  test(
    "close() is idempotent and cancels further rebuilds",
    async () => {
      const dir = await scaffoldTemplate(pkgTmp, "watch-close");
      await writeFile(join(dir, "tdk.config.ts"), configFor(), "utf8");
      const configPath = join(dir, "tdk.config.ts");

      const { runBuild } = countingRunner();
      const messages: WatchMessage[] = [];
      const handle = startWatch(configPath, (m) => messages.push(m), { debounceMs: 20, runBuild });
      await handle.nextCycle();
      handle.close();
      handle.close(); // idempotent — no throw
      const before = headers(messages);

      // A change after close must NOT produce another cycle. `schedule()` returns
      // synchronously on its `closed` guard, so nothing here is racing our OWN
      // logic — but a real fs.watch event still has to (fail to) arrive before an
      // absence is provable, and that delivery is genuine OS latency. Rather than
      // one fixed sleep (racy under full-suite scheduler contention — the same
      // class of flake as #33/#47), re-poke a few times and fail immediately the
      // moment a cycle appears; the outer test timeout is the generous headroom
      // for setup/scaffold cost under load, not for this poll itself.
      await assertNoCycleWithin(handle, messages, dir, before, 3_000);
    },
    SUBPROCESS_TIMEOUT,
  );
});

describe("startWatch — one true end-to-end cycle (real subprocess build)", () => {
  // This is the ONE test in the suite that stays fully real: a real `fs.watch`
  // AND a real `bun run cli.ts build` subprocess per cycle (the default
  // runner) — its realness is the point, so it is deliberately NOT converted
  // to fake timers/a fake runner. The SECOND cycle uniquely depends on macOS
  // FSEvents actually delivering the template.ts change (cycle 1 needs no OS
  // event at all — `startWatch` kicks it immediately) — a known-flaky
  // primitive under load, the same reason `pokeUntil`/`assertNoCycleWithin`
  // above re-poke rather than trust a single event. So the edit is re-applied
  // (idempotently — same final content each time) until the rebuild lands,
  // rather than writing once and hoping the one event survives; that retry
  // loop absorbs delivery flakiness, so it doesn't need an ever-larger single
  // timeout on top of it.
  test(
    "initial build writes artifacts immediately; a template edit triggers a rebuild that picks it up",
    async () => {
      const dir = await scaffoldTemplate(pkgTmp, "watch-e2e");
      await writeFile(join(dir, "tdk.config.ts"), configFor(), "utf8");
      const configPath = join(dir, "tdk.config.ts");
      const nonprodOut = join(dir, "out-nonprod", "cake-order-fixture", "template.yaml");

      const messages: WatchMessage[] = [];
      // The DEFAULT runner: a real `bun run cli.ts build` subprocess per cycle.
      const handle = startWatch(configPath, (m) => messages.push(m), { debounceMs: 20 });
      try {
        // The initial build runs immediately (before any change) and writes to disk.
        await withTimeout(handle.nextCycle(), SUBPROCESS_TIMEOUT, "initial build");
        const initial = await readFile(nonprodOut, "utf8");
        expect(initial).toContain("cluster: test-cluster");
        expect(messages.some((m) => m.text.includes("Compiled 2 artifact(s)"))).toBe(true);
        expect(handle.watchDir).toBe(dir);
        expect(handle.configPath).toBe(resolve(configPath));

        // Edit the template's message → the fresh subprocess re-imports it (no stale
        // module cache) and the compiled YAML changes on the next cycle. Re-apply the
        // edit until a cycle lands: a single fs.watch event can be dropped under
        // full-suite load, and the pickup contract (not one specific event's
        // delivery) is what this asserts.
        const src = await readFile(join(dir, "template.ts"), "utf8");
        const edited = src.replace("Order for", "Fresh order for");
        await pokeEditUntilRebuilt(handle, join(dir, "template.ts"), edited, SUBPROCESS_TIMEOUT, async () =>
          (await readFile(nonprodOut, "utf8")).includes("Fresh order for"),
        );
        const updated = await readFile(nonprodOut, "utf8");
        expect(updated).toContain("Fresh order for");
      } finally {
        handle.close();
      }
    },
    // Headroom for the initial-build wait plus the re-poke loop's own deadline,
    // plus scaffold overhead.
    SUBPROCESS_TIMEOUT * 2 + 10_000,
  );
});

/** Count the rebuild-cycle headers emitted so far (one per cycle). */
function headers(messages: WatchMessage[]): number {
  return messages.filter((m) => m.text.includes("rebuilding")).length;
}

/**
 * Poke the watched tree (write + touch a `.ts` file) repeatedly until the cycle
 * count reaches `target`, or fail after a deadline. macOS `fs.watch` can drop an
 * event under parallel-suite load; re-poking makes the "a change triggers a
 * rebuild" contract robust without depending on a single event's delivery. The
 * default deadline leaves headroom below the enclosing test's
 * `SUBPROCESS_TIMEOUT` for full-suite scheduler contention (see #47).
 */
async function pokeUntil(
  handle: { nextCycle(): Promise<void> },
  messages: WatchMessage[],
  dir: string,
  target: number,
  deadlineMs = 20_000,
): Promise<void> {
  const start = Date.now();
  let n = 0;
  while (headers(messages) < target) {
    if (Date.now() - start > deadlineMs) throw new Error(`no cycle reached ${target} after ${deadlineMs}ms`);
    await writeFile(join(dir, "poke.ts"), `export const poke = ${n++};\n`, "utf8");
    await utimes(join(dir, "poke.ts"), new Date(), new Date());
    // Wait for either a cycle or a short beat, then re-check and re-poke.
    await Promise.race([handle.nextCycle(), Bun.sleep(400)]);
  }
}

/**
 * Like {@link pokeUntil}, but re-applies a SPECIFIC edit (idempotently — the
 * same final `content` each retry) to `filePath` until `settled()` reports the
 * rebuilt ARTIFACT reflects it. The exit condition is deliberately the settled
 * content, not a cycle count: a cycle header prints when a rebuild STARTS, so
 * returning on the header races the subprocess's artifact write — on a slower
 * machine the caller then reads the stale output (the exact CI failure mode
 * this replaced).
 */
async function pokeEditUntilRebuilt(
  handle: { nextCycle(): Promise<void> },
  filePath: string,
  content: string,
  deadlineMs: number,
  settled: () => Promise<boolean>,
): Promise<void> {
  const start = Date.now();
  while (!(await settled())) {
    if (Date.now() - start > deadlineMs)
      throw new Error(`the edit did not settle into the artifact after ${deadlineMs}ms`);
    await writeFile(filePath, content, "utf8");
    await utimes(filePath, new Date(), new Date());
    // Wait for either a cycle or a short beat, then re-check and re-apply.
    await Promise.race([handle.nextCycle(), Bun.sleep(400)]);
  }
}

/**
 * The inverse of {@link pokeUntil}: prove a change does NOT produce a new
 * cycle. A single write-then-sleep can't tell "no event fired" apart from
 * "the event just hasn't arrived yet" under scheduler contention, so instead
 * poke the watched tree several times, checking `headers(messages)` against
 * `baseline` after each and failing the instant it rises. Each poke waits a
 * fixed beat before the next, capped by `deadlineMs` total — generous enough
 * to absorb full-suite fs.watch latency, but it does not itself remain slow
 * in the common case, since a mid-loop failure surfaces immediately.
 */
async function assertNoCycleWithin(
  handle: { nextCycle(): Promise<void> },
  messages: WatchMessage[],
  dir: string,
  baseline: number,
  deadlineMs: number,
  beatMs = 500,
): Promise<void> {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < deadlineMs) {
    await writeFile(join(dir, "poke.ts"), `export const poke = ${n++};\n`, "utf8");
    await utimes(join(dir, "poke.ts"), new Date(), new Date());
    await Promise.race([handle.nextCycle(), Bun.sleep(beatMs)]);
    expect(headers(messages)).toBe(baseline);
  }
}

/** A fake `runBuild` that succeeds instantly and counts its invocations. */
function countingRunner(): { runBuild: BuildRunner; calls: () => number } {
  let n = 0;
  const runBuild: BuildRunner = async (_config: string, emit: WatchEmit) => {
    n += 1;
    emit({ stream: "out", text: "\nCompiled 2 artifact(s).\n" });
    return 0;
  };
  return { runBuild, calls: () => n };
}

/** Reject if `p` doesn't settle within `ms` — turns a hung watcher into a clear failure. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)),
  ]);
}
