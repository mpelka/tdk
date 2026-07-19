import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatModelErrors, validateModel } from "./validate.ts";

// The established doc discipline: every fenced MODEL sample in the producer guide
// (apps/docs/guide/migrating.md) must validate against the REAL schema + semantic
// checks — so the guide can never drift from the contract it documents.

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, "..", "..", "..", "..", "apps", "docs", "guide", "migrating.md");
const doc = readFileSync(docPath, "utf8");

/** Extract every ```json fenced block from the markdown. */
function jsonFences(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```json\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null = re.exec(markdown);
  while (m !== null) {
    blocks.push(m[1]);
    m = re.exec(markdown);
  }
  return blocks;
}

const fences = jsonFences(doc);

describe("migrating.md — fenced samples", () => {
  test("the guide has model samples to check", () => {
    expect(fences.length).toBeGreaterThan(3);
  });

  test("every ```json fence is valid JSON", () => {
    for (const block of fences) {
      expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  // A model fence has a `questions` array; the mapping/report fences do not.
  const modelFences = fences
    .map((b) => JSON.parse(b) as Record<string, unknown>)
    .filter((o) => Array.isArray(o.questions));

  test("the guide covers every node kind across its model samples", () => {
    // At least one model with logic, one with lookups, one with effects.
    expect(modelFences.some((m) => Array.isArray(m.logic))).toBe(true);
    expect(modelFences.some((m) => Array.isArray(m.lookups))).toBe(true);
    expect(modelFences.some((m) => Array.isArray(m.effects))).toBe(true);
  });

  test.each(
    modelFences.map((m, i) => [i, m] as const),
  )("model sample #%i validates against the schema", (_i, model) => {
    const result = validateModel(model);
    if (!result.valid) throw new Error(formatModelErrors(result.errors));
    expect(result.valid).toBe(true);
  });
});
