// The per-source latest-wins guard — the pure core of the trace view's sequencing.
//
// THE PROBLEM. The trace view retains two slots (LOCAL simulate, Backstage dry-run), each
// fed by ASYNC work (a spawned `execute()`, a POST). Within ONE source, a SLOW older run
// resolving after a newer one must NOT clobber the fresher result. Across sources, a
// dry-run and a local trace coexist (separate slots), so a slow dry-run must never
// invalidate a pending local run, and vice versa — the two are independent.
//
// THE MODEL. Two independent monotonic counters. `stamp(source)` bumps that source's
// counter and returns the new token; `isLatest(source, token)` reports whether the token
// is still that source's newest. The extension `stamp`s at the START of a run and, when the
// async work resolves, posts only if `isLatest` — the guard the form preview applies before
// touching the shared view. Pure + dependency-free, so the sequencing logic is unit-tested
// without a live extension host.

/** The two retained trace sources — each with its own independent sequence. */
export type TraceSource = "local" | "dryRun";

/** A pair of independent monotonic guards, one per trace source. */
export interface SourceSeqGuard {
  /** Begin a run for `source`: bump its counter and return the new token. */
  stamp(source: TraceSource): number;
  /** Whether `token` is still the LATEST stamp for `source` (else a stale run must not post). */
  isLatest(source: TraceSource, token: number): boolean;
}

/** Build a fresh per-source guard with both counters at zero. */
export function createSourceSeqGuard(): SourceSeqGuard {
  const counters: Record<TraceSource, number> = { local: 0, dryRun: 0 };
  return {
    stamp(source) {
      counters[source] += 1;
      return counters[source];
    },
    isLatest(source, token) {
      return token === counters[source];
    },
  };
}
