// Typed accessors into COMPILED entities, for tests. Replaces the blanket
// `as any` casts on compiled output with a narrow, honest shape for the
// JSON-Schema `dependencies` tree that `dep.when`/`showWhen` emit.

import type { PageObject } from "../index.ts";

/** A property fragment inside a compiled branch (`const`/`enum`/`not` matches). */
export interface DepPropertySchema {
  const?: unknown;
  enum?: unknown[];
  not?: unknown;
  [key: string]: unknown;
}

/** One compiled `oneOf` branch of a dependencies entry. */
export interface DepBranchObj {
  properties: Record<string, DepPropertySchema>;
  required?: string[];
  dependencies?: DepTree;
}

/** A compiled `dependencies` object: controller name → its `oneOf` branches. */
export type DepTree = Record<string, { oneOf: DepBranchObj[] }>;

/** A compiled page's `dependencies`, typed (empty object when absent). */
export function depTree(pg: PageObject): DepTree {
  return (pg.dependencies ?? {}) as DepTree;
}
