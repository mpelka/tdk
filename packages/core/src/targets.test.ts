import { describe, expect, test } from "bun:test";
import { defineConfig, p, Template } from "./index.ts";

class Demo extends Template {
  id = "demo";
  title = "Demo";
  type = "service";
  params = { name: p.string() };
  build() {
    return [{ id: "s", action: "debug:log" }];
  }
}

describe("defineConfig", () => {
  test("returns the config object unchanged (identity helper)", () => {
    const demo = new Demo();
    const config = defineConfig({
      templates: [demo],
      targets: {
        nonprod: { env: "test", outDir: "dist/nonprod" },
        prod: { env: "prod", outDir: "dist/prod" },
      },
    });
    expect(config.templates).toEqual([demo]);
    expect(config.targets.nonprod).toEqual({
      env: "test",
      outDir: "dist/nonprod",
    });
    expect(config.targets.prod.env).toBe("prod");
  });

  test("accepts arbitrary target names + env strings (no special nonprod/prod keys)", () => {
    const demo = new Demo();
    const config = defineConfig({
      templates: [demo],
      targets: {
        edge: { env: "dev", outDir: "dist/dev" },
        canary: { env: "staging", outDir: "dist/staging" },
        live: { env: "prod", outDir: "dist/prod" },
      },
    });
    expect(Object.keys(config.targets)).toEqual(["edge", "canary", "live"]);
    expect(config.targets.canary.env).toBe("staging");
  });

  test("accepts a single-target config", () => {
    const demo = new Demo();
    const config = defineConfig({
      templates: [demo],
      targets: { only: { env: "production", outDir: "dist" } },
    });
    expect(Object.keys(config.targets)).toEqual(["only"]);
  });

  test("throws on zero targets", () => {
    expect(() => defineConfig({ templates: [new Demo()], targets: {} })).toThrow(/at least one entry/);
  });
});
