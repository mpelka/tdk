import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { version } from "./index.ts";

test("exports a non-empty version string", () => {
  expect(typeof version).toBe("string");
  expect(version.length).toBeGreaterThan(0);
});

test("the exported version matches package.json (bump both together)", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  expect(version).toBe(pkg.version);
});
