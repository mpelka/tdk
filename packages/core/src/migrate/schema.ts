// The committed JSON Schema, loaded lazily.
//
// `model.schema.json` is a REAL committed artifact — the public contract producers
// validate against. It is loaded on first use (no top-level IO, so `sideEffects:
// false` holds) with `node:fs` (core stays Node-clean, ADR-0001).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let cached: Record<string, unknown> | undefined;

/** The parsed model JSON Schema (cached after first read). */
export function modelSchema(): Record<string, unknown> {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(here, "model.schema.json"), "utf8")) as Record<string, unknown>;
  }
  return cached;
}
