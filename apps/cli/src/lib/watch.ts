// The `tdk build --watch` operation: a long-running mode that re-runs the whole
// `build` pipeline (compile + validate every artifact, then write to disk) each
// time a source file under the config's directory changes. Pure in the lib
// sense — it never touches `process` directly (no stdout/stderr writes, no
// exit, no signal handlers). It takes an `emit` sink and returns a handle the
// caller drives; `cli.ts` owns the streams, the SIGINT handler, and the exit
// code.
//
// v1 watching strategy (deliberately coarse — see the PR / issue #44):
//   - Recursively watch the CONFIG FILE'S DIRECTORY for `.ts` changes
//     (`fs.watch(dir, { recursive: true })` — supported on macOS and Linux on
//     modern Node/Bun).
//   - IGNORE events under the config's output dirs, `node_modules`,
//     `__snapshots__`, and any dotdir — so our own writes never retrigger, and
//     churny/irrelevant trees stay quiet.
//   - A surviving `.ts` event schedules a DEBOUNCED (~150ms) full rebuild, so a
//     burst of saves (a formatter rewriting many files) collapses to one cycle.
//   - Import-graph precision is explicitly NOT done for v1: any `.ts` change in
//     the tree rebuilds every template × target, not just the affected ones.
//
// Each cycle prints a header, then RE-RUNS `tdk build` in a FRESH SUBPROCESS.
// The subprocess matters: Bun caches ESM modules by path, and a config's static
// `import Tpl from "./template.ts"` stays cached across an in-process re-import
// (only a directly query-busted import re-evaluates) — so an in-process rebuild
// would never see an edited template. A fresh `bun run <cli> build` has a clean
// module cache, and reuses the EXACT `tdk build` pipeline (compile + validate +
// write) byte-for-byte. A non-zero exit (a compile/validation failure) prints
// the child's stderr and KEEPS WATCHING — the next save retries. The initial
// build runs once immediately, before watching begins.

import { watch as fsWatch } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TdkConfig } from "@tdk/core";
import { formatError } from "./errors.ts";

/** The default debounce window (ms) between the last change and a rebuild. */
export const DEFAULT_DEBOUNCE_MS = 150;

/**
 * A line the watcher wants written. `out` → stdout, `err` → stderr. The caller
 * maps these to the real streams; tests capture them into an array. Every
 * message already carries its own trailing newline.
 */
export interface WatchMessage {
  stream: "out" | "err";
  text: string;
}

/** Where a watcher writes its progress + errors. Injected so tests can capture. */
export type WatchEmit = (msg: WatchMessage) => void;

/** A running watcher. `close()` stops the fs watcher and cancels a pending rebuild. */
export interface WatchHandle {
  /** The resolved absolute config path being watched. */
  readonly configPath: string;
  /** The directory whose `.ts` files trigger rebuilds. */
  readonly watchDir: string;
  /** Stop watching and cancel any pending debounced rebuild. Idempotent. */
  close(): void;
  /**
   * Resolve once the current (or next) rebuild cycle settles — for tests that
   * want to `await` a cycle after touching a file. Never rejects: a failed
   * build is a settled cycle too (the watcher survives it).
   */
  nextCycle(): Promise<void>;
}

/** An opaque debounce-timer handle — the return of whatever `setTimer` is used. */
export type TimerHandle = unknown;

/** Options for {@link startWatch}. */
export interface WatchOptions {
  /** Debounce window in ms (default {@link DEFAULT_DEBOUNCE_MS}). */
  debounceMs?: number;
  /**
   * Injectable timers for the debounce — default the real ones. Tests can pass
   * fakes to drive the debounce deterministically without wall-clock waits.
   */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /**
   * How each cycle runs the build — defaults to spawning `tdk build` in a fresh
   * subprocess (a clean module cache). Tests can inject a fake to run cycles
   * without a real subprocess.
   */
  runBuild?: BuildRunner;
}

/**
 * Recognize a change that is (or is an editor's atomic-save decoration of) a
 * `.ts` file. A plain `foo.ts` obviously counts. Many editors — and `mv`/`sed
 * -i` — save by writing a TEMP sibling and renaming it over the target, and on
 * macOS `fs.watch` reports the rename against the TEMP name, not the final one
 * (`template.ts.new`, `template.ts~`, `template.ts.12345`). So also count a
 * basename whose recognized temp decoration, once stripped, ends in `.ts` — a
 * missed atomic save would otherwise silently skip a rebuild. A dot-prefixed
 * swap file (`.template.ts.swp`) is deliberately NOT counted here; it is caught
 * by the dotfile exclusion in `shouldTrigger` (a swap is not the real save).
 */
function looksLikeTsChange(basename: string): boolean {
  if (basename.endsWith(".ts")) return true;
  // Strip one recognized atomic-save decoration, then re-check for `.ts`.
  //   trailing `~`                     → vim/emacs backup       (foo.ts~)
  //   trailing `.tmp|.new|.bak|.orig`  → common atomic-rename   (foo.ts.new)
  //   trailing `.<digits/hex>`         → randomized temp suffix (foo.ts.a1b2)
  const stripped = basename.replace(/(?:~|\.(?:tmp|new|bak|orig|swp|swx|[0-9a-fA-F]{1,10}))$/, "");
  return stripped !== basename && stripped.endsWith(".ts");
}

/**
 * Should a changed path trigger a rebuild? Only `.ts` files (and editors'
 * atomic-save decorations of them — see {@link looksLikeTsChange}) count, and
 * never anything inside an output dir, `node_modules`, `__snapshots__`, or a
 * dotdir. `outputDirs` are absolute; `changedAbs` is the absolute changed path.
 * Exported for direct unit testing.
 */
export function shouldTrigger(changedAbs: string, watchDir: string, outputDirs: readonly string[]): boolean {
  const rel = relative(watchDir, changedAbs);
  // Outside the watched tree (or the dir itself) — ignore.
  if (rel === "" || rel.startsWith("..")) return false;

  const segments = rel.split(sep);
  for (const segment of segments) {
    // A dotdir/dotfile segment (`.git`, `.tmp-x`, a dot-prefixed swap file) is
    // out. A bare `.` never appears in a normalized relative path.
    if (segment.startsWith(".")) return false;
    if (segment === "node_modules" || segment === "__snapshots__") return false;
  }

  // Only a `.ts` change (or an atomic-save decoration of one) is relevant.
  if (!looksLikeTsChange(segments[segments.length - 1] ?? "")) return false;

  // Under any resolved output dir — this is (or could be) our own write.
  for (const outDir of outputDirs) {
    if (changedAbs === outDir || changedAbs.startsWith(outDir + sep)) return false;
  }
  return true;
}

/**
 * Resolve the output directories to exclude from watching, from the config's
 * targets. A target's `outDir` (resolved against the config dir) is a known
 * output root; an `out(meta)`-based target has no static dir, so the watcher
 * folds in the parent dir of each produced artifact after a build instead.
 * Returns absolute, de-duplicated dirs. Never throws — a malformed config just
 * yields no dirs (the standard exclusions still apply).
 */
export function outputDirsFromConfig(config: TdkConfig | undefined, configDir: string): string[] {
  const dirs = new Set<string>();
  const targets = config?.targets;
  if (targets) {
    for (const target of Object.values(targets)) {
      if (target && typeof target === "object" && typeof target.outDir === "string") {
        dirs.add(resolve(configDir, target.outDir));
      }
    }
  }
  return [...dirs];
}

/** A short local timestamp (`HH:MM:SS`) for the cycle header — stable, locale-free. */
function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * Import the config module FRESH to read its target `outDir`s (a query-bust
 * re-evaluates the config body, which is all the ignore set needs — the
 * `outDir` strings are static in the config). Its statically-imported templates
 * may be cache-stale, but their content is irrelevant here. Returns undefined
 * on any failure (the standard exclusions still apply).
 */
async function readConfigOutputDirs(configPath: string): Promise<string[]> {
  try {
    const mod = (await import(`${configPath}?t=${Date.now()}`)) as { default?: TdkConfig };
    return outputDirsFromConfig(mod.default, dirname(configPath));
  } catch {
    return [];
  }
}

/** The `tdk` CLI entry (`apps/cli/src/cli.ts`) — the sibling of this lib dir's parent. */
const CLI_ENTRY = fileURLToPath(new URL("../cli.ts", import.meta.url));

/**
 * Spawn `bun run <cli.ts> build <config>` and stream its stdout/stderr through
 * `emit`. Injectable so tests can substitute a fake runner. Resolves with the
 * child's exit code; never throws for a non-zero exit (a failed build is a
 * survivable cycle).
 */
export type BuildRunner = (configPath: string, emit: WatchEmit) => Promise<number>;

const spawnBuild: BuildRunner = async (configPath, emit) => {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "build", configPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (out) emit({ stream: "out", text: out });
  if (err) emit({ stream: "err", text: err });
  return code;
};

/**
 * Run ONE build cycle: header, then `tdk build` in a fresh subprocess (its
 * stdout/stderr streamed through `emit`). Never throws — a non-zero child exit
 * is reported (its stderr already streamed) and swallowed so the watcher
 * survives it. Returns the freshly resolved output dirs (so the watcher keeps
 * its ignore set current as the config's targets change between saves).
 */
async function runCycle(configPath: string, emit: WatchEmit, now: Date, runBuild: BuildRunner): Promise<string[]> {
  emit({ stream: "out", text: `\n[${stamp(now)}] rebuilding…\n` });
  try {
    const code = await runBuild(configPath, emit);
    if (code !== 0) emit({ stream: "err", text: `build exited with code ${code} — watching for the next change.\n` });
  } catch (err) {
    // A spawn failure (not a build failure) — report and keep watching.
    emit({ stream: "err", text: `${formatError(err)}\n` });
  }
  return readConfigOutputDirs(configPath);
}

/**
 * Start watching. Runs the initial build IMMEDIATELY, then watches the config
 * dir for `.ts` changes and rebuilds (debounced) on each surviving event.
 * Returns a handle to stop it. The initial build's completion is awaitable via
 * the returned handle's first `nextCycle()`.
 *
 * The watcher never throws for a build failure — it prints the error and keeps
 * running. It DOES throw synchronously if `fs.watch` can't be established (e.g.
 * the config dir doesn't exist), which the caller surfaces as a startup error.
 */
export function startWatch(configArg: string | undefined, emit: WatchEmit, opts: WatchOptions = {}): WatchHandle {
  const configPath = resolve(configArg ?? "tdk.config.ts");
  const watchDir = dirname(configPath);
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer: (fn: () => void, ms: number) => TimerHandle = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: (handle: TimerHandle) => void =
    opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const runBuild = opts.runBuild ?? spawnBuild;

  // The ignore set: statically-known output dirs, refreshed after every cycle.
  let outputDirs: string[] = [];
  let closed = false;
  let pending: TimerHandle | undefined;

  // A settle latch: every cycle resolves the currently-armed promise, then arms
  // a fresh one for the next `nextCycle()` caller. So a caller who awaits BEFORE
  // touching a file (the initial build) and one who awaits AFTER (a change) both
  // get a cycle.
  let resolveCycle!: () => void;
  let cyclePromise = new Promise<void>((r) => {
    resolveCycle = r;
  });
  const settle = () => {
    const done = resolveCycle;
    cyclePromise = new Promise<void>((r) => {
      resolveCycle = r;
    });
    done();
  };

  // Serialize cycles: never let two builds overlap (a change mid-build queues
  // one more run). `running` is the in-flight cycle; `again` marks a re-request.
  let running: Promise<void> | undefined;
  let again = false;
  const cycle = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        outputDirs = await runCycle(configPath, emit, new Date(), runBuild);
        settle();
      } while (again && !closed);
      running = undefined;
    })();
    return running;
  };

  const schedule = () => {
    if (closed) return;
    if (pending) clearTimer(pending);
    pending = setTimer(() => {
      pending = undefined;
      void cycle();
    }, debounceMs);
  };

  // Kick the initial build immediately (not debounced) — before watching.
  void cycle();

  // Establish the recursive watch. Throws synchronously on a bad dir — the
  // caller surfaces it as a startup failure (the initial cycle already ran).
  const watcher = fsWatch(watchDir, { recursive: true }, (_event, filename) => {
    if (closed || filename == null) return;
    const changedAbs = resolve(watchDir, filename.toString());
    if (shouldTrigger(changedAbs, watchDir, outputDirs)) schedule();
  });
  watcher.on("error", (err) => {
    emit({ stream: "err", text: `watch error: ${formatError(err)}\n` });
  });

  return {
    configPath,
    watchDir,
    close() {
      if (closed) return;
      closed = true;
      if (pending) {
        clearTimer(pending);
        pending = undefined;
      }
      watcher.close();
      // Release any final awaiter so a `nextCycle()` racing close never hangs.
      settle();
    },
    nextCycle() {
      return cyclePromise;
    },
  };
}
