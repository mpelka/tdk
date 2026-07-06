import { beforeEach, describe, expect, test } from "bun:test";
import { _envRegistrySize } from "./env.ts";
import { _resetEnvRegistry, EnvPick, env, exclusiveValuesByEnv, isEnvPick } from "./index.ts";

/** The string values exclusive to `envName` across the registry (test helper). */
function exclusiveFor(envName: string): Set<string> {
  return exclusiveValuesByEnv().get(envName) ?? new Set<string>();
}

beforeEach(() => _resetEnvRegistry());

describe("env.pick", () => {
  test("resolves the value for the requested env", () => {
    const pick = env.pick({ test: "t", prod: "p" });
    expect(pick.resolve("test")).toBe("t");
    expect(pick.resolve("prod")).toBe("p");
  });

  test("resolves an arbitrary env name", () => {
    const pick = env.pick({ dev: "d", staging: "s", prod: "p" });
    expect(pick.resolve("dev")).toBe("d");
    expect(pick.resolve("staging")).toBe("s");
    expect(pick.resolve("prod")).toBe("p");
  });

  test("falls back to the reserved default key when the env is absent", () => {
    const pick = env.pick({ prod: "eu-west", default: "eu-central" });
    expect(pick.resolve("prod")).toBe("eu-west");
    expect(pick.resolve("dev")).toBe("eu-central");
    expect(pick.resolve("anything")).toBe("eu-central");
  });

  test("throws (naming known envs + the miss) for an unknown env with no default", () => {
    const pick = env.pick({ test: "t", prod: "p" });
    expect(() => pick.resolve("staging")).toThrow(
      'env.pick has no value for env "staging" (knows: test, prod) — add a "staging" entry or a "default".',
    );
  });

  test("requires at least one value", () => {
    expect(() => env.pick({})).toThrow(/at least one env value/);
  });

  test("renders to the env-specific string fragment as a RawRef", () => {
    const pick = env.pick({ test: 1, prod: 2 });
    expect(pick.render({ env: "test" })).toBe("1");
    expect(pick.render({ env: "prod" })).toBe("2");
  });

  test("render throws on a non-scalar value instead of '[object Object]'", () => {
    const objPick = env.pick({ test: { url: "t" }, prod: { url: "p" } });
    expect(() => objPick.render({ env: "test" })).toThrow(/cannot interpolate an object/);
    const arrPick = env.pick({ test: ["t"], prod: ["p"] });
    expect(() => arrPick.render({ env: "test" })).toThrow(/cannot interpolate an array/);
    const nullPick = env.pick<string | null>({ test: null, prod: "p" });
    expect(() => nullPick.render({ env: "test" })).toThrow(/cannot interpolate null/);
  });
});

describe("env.pick registry growth", () => {
  test("identical value pairs register once (build() re-runs must not grow it)", () => {
    for (let i = 0; i < 5; i++) env.pick({ test: "t", prod: "p" });
    expect(_envRegistrySize()).toBe(1);
    env.pick({ test: "t2", prod: "p2" });
    expect(_envRegistrySize()).toBe(2);
    // Dedupe never weakens the safety scan.
    expect(exclusiveFor("prod")).toEqual(new Set(["p", "p2"]));
  });

  test("string-free picks are not registered (they can't affect the scan)", () => {
    env.pick({ test: 1, prod: 2 });
    env.pick({ test: true, prod: false });
    expect(_envRegistrySize()).toBe(0);
  });
});

describe("isEnvPick", () => {
  test("true for an EnvPick, false otherwise", () => {
    expect(isEnvPick(env.pick({ test: "a", prod: "b" }))).toBe(true);
    expect(isEnvPick(new EnvPick({ test: "a", prod: "b" }))).toBe(true);
    expect(isEnvPick({})).toBe(false);
    expect(isEnvPick(null)).toBe(false);
    expect(isEnvPick("x")).toBe(false);
  });
});

describe("exclusiveValuesByEnv", () => {
  test("collects prod values that never appear as a test value (two-env back-compat)", () => {
    env.pick({ test: "t1", prod: "prod-secret" });
    env.pick({ test: "shared", prod: "shared" });
    const prodOnly = exclusiveFor("prod");
    expect(prodOnly.has("prod-secret")).toBe(true);
    expect(prodOnly.has("shared")).toBe(false);
    expect(exclusiveFor("test").has("t1")).toBe(true);
    expect(exclusiveFor("test").has("shared")).toBe(false);
  });

  test("three envs: each env's exclusive value is its own; a value shared by two is exclusive to neither", () => {
    env.pick({ dev: "dev-only", staging: "stg-only", prod: "prod-only" });
    // "eu-west" is used by BOTH staging and prod -> shared, not exclusive.
    env.pick({ staging: "eu-west", prod: "eu-west", dev: "eu-central" });
    expect(exclusiveFor("dev")).toEqual(new Set(["dev-only", "eu-central"]));
    expect(exclusiveFor("staging")).toEqual(new Set(["stg-only"]));
    expect(exclusiveFor("prod")).toEqual(new Set(["prod-only"]));
  });

  test("a default value is never exclusive to any env", () => {
    env.pick({ prod: "prod-only", default: "shared-default" });
    // "shared-default" applies to every env via `default` -> exclusive to none.
    expect(exclusiveFor("prod")).toEqual(new Set(["prod-only"]));
    for (const set of exclusiveValuesByEnv().values()) {
      expect(set.has("shared-default")).toBe(false);
    }
  });

  test("ignores non-string pick values", () => {
    env.pick({ test: 1, prod: 2 });
    expect(exclusiveValuesByEnv().size).toBe(0);
  });

  test("an empty registry yields an empty map", () => {
    expect(exclusiveValuesByEnv().size).toBe(0);
  });
});
