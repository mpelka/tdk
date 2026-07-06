// Behaviour + type coverage for the functional load() API (compile-time data).
//
// load({ env }) fetches the bakery menu per target env, so nonprod and prod bake
// DIFFERENT options. Proven here: env-varying baked options, the fixture-tier
// `loaded` injection (skips load(), no network), per-env load memoization, that
// the synchronous compile() refuses a load() template, and the type inference
// (data + f), the last verified by tsc.

import { afterEach, describe, expect, test } from "bun:test";
import type { LoadContext, Ref } from "../index.ts";
import { compile, compileAll, compileResolved, defineTemplate, execute, p, page, step } from "../index.ts";
import { bakeryCalls, resetBakeryCalls } from "./bakery-menu.ts";
import { load } from "./cake-order-loaded.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;
const prod = { env: "prod", outDir: "dist/prod" } as const;

afterEach(resetBakeryCalls);

/**
 * A fresh loaded template per call — each gets its own per-instance load cache, so
 * call-count / prepared-state assertions stay isolated across tests. Authored
 * exactly like the exported `cakeOrderLoaded`, reusing the same `load`.
 */
function freshLoaded() {
  return defineTemplate({
    id: "cake-order-loaded",
    title: "Cake Order (loaded)",
    type: "service",
    load,
    parameters: (data) => [
      page("Cake", {
        flavor: p.enum(data.flavors, { title: "Flavour", required: true }),
        size: p.enum(data.sizes, { title: "Size", required: true }),
      }),
    ],
    steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor, size: f.size } })],
  });
}

/** Pull the baked `flavor` enum options off a compiled entity's first page. */
function bakedFlavors(object: { spec: { parameters: unknown } }): string[] | undefined {
  const pages = object.spec.parameters as Array<{ properties: Record<string, { enum?: string[] }> }>;
  return pages[0]?.properties.flavor?.enum;
}

describe("defineTemplate load() — env-varying baked options", () => {
  test("nonprod bakes the test menu; prod bakes the larger prod menu", async () => {
    const tpl = freshLoaded();
    const testObj = (await compileResolved(tpl, nonprod)).object;
    const prodObj = (await compileResolved(tpl, prod)).object;
    expect(bakedFlavors(testObj)).toEqual(["Vanilla", "Chocolate"]);
    expect(bakedFlavors(prodObj)).toEqual(["Vanilla", "Chocolate", "Red Velvet", "Carrot"]);
  });

  test("compileAll prepares per target — each env's YAML gets its own menu", async () => {
    const jobs = await compileAll([freshLoaded()], { nonprod, prod }, { write: false });
    const job = (name: string) => jobs.find((j) => j.targetName === name)!;
    expect(bakedFlavors(job("nonprod").result.object)).toEqual(["Vanilla", "Chocolate"]);
    expect(bakedFlavors(job("prod").result.object)).toEqual(["Vanilla", "Chocolate", "Red Velvet", "Carrot"]);
  });
});

describe("defineTemplate load() — mock tiers + caching", () => {
  test("fixture `loaded` injects data and skips load() (no bakery call)", async () => {
    const run = await execute(freshLoaded(), {
      parameters: { flavor: "Espresso", size: "XL" },
      loaded: { flavors: ["Espresso"], sizes: ["XL"] },
      steps: { order: { output: {} } },
    });
    expect(bakeryCalls.flavors).toBe(0); // load() never ran
    expect(run.steps.order!.input).toEqual({ flavor: "Espresso", size: "XL" });
  });

  test("execute without `loaded` runs load() for real", async () => {
    const run = await execute(freshLoaded(), {
      parameters: { flavor: "Chocolate", size: "Small" },
      steps: { order: { output: {} } },
    });
    expect(bakeryCalls.flavors).toBe(1);
    expect(run.steps.order!.input).toEqual({ flavor: "Chocolate", size: "Small" });
  });

  test("load() runs once per env (memoized)", async () => {
    const tpl = freshLoaded();
    await compileResolved(tpl, nonprod);
    await compileResolved(tpl, nonprod); // same env → cached, no second fetch
    expect(bakeryCalls.flavors).toBe(1);
    await compileResolved(tpl, prod); // new env → one more fetch
    expect(bakeryCalls.flavors).toBe(2);
  });
});

describe("defineTemplate load() — synchronous compile guard", () => {
  test("compile() throws on a load() template, pointing at the async path", () => {
    expect(() => compile(freshLoaded(), nonprod)).toThrow(/declares load\(\)/);
    expect(bakeryCalls.flavors).toBe(0); // guard fires before any fetch
  });
});

describe("defineTemplate load() — concurrent compiles stay isolated", () => {
  test("Promise.all over test+prod never bakes one env's menu into the other's artifact", async () => {
    const tpl = freshLoaded();
    // Warm both env caches first: cached loads resolve in MICROTASKS, the
    // tightest interleaving — exactly where the old shared-form mutation baked
    // prod data into the test artifact.
    await compileResolved(tpl, nonprod);
    await compileResolved(tpl, prod);
    for (let i = 0; i < 5; i++) {
      const [testRes, prodRes] = await Promise.all([compileResolved(tpl, nonprod), compileResolved(tpl, prod)]);
      expect(bakedFlavors(testRes.object)).toEqual(["Vanilla", "Chocolate"]);
      expect(bakedFlavors(prodRes.object)).toEqual(["Vanilla", "Chocolate", "Red Velvet", "Carrot"]);
    }
  });

  test("a slow load() interleaved with a fast one keeps each artifact on its own env", async () => {
    const tpl = defineTemplate({
      id: "slow-loaded",
      title: "Slow Loaded",
      type: "service",
      load: async ({ env }: LoadContext) => {
        // test is SLOWER than prod, so prod's form is built while test waits.
        await new Promise((r) => setTimeout(r, env === "test" ? 20 : 1));
        return { flavors: env === "test" ? ["Vanilla"] : ["Vanilla", "Carrot"] };
      },
      parameters: (data) => [page("Cake", { flavor: p.enum(data.flavors, { required: true }) })],
      steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor } })],
    });
    const [testRes, prodRes] = await Promise.all([compileResolved(tpl, nonprod), compileResolved(tpl, prod)]);
    expect(bakedFlavors(testRes.object)).toEqual(["Vanilla"]);
    expect(bakedFlavors(prodRes.object)).toEqual(["Vanilla", "Carrot"]);
  });
});

describe("defineTemplate load() — failure is not cached", () => {
  test("a rejected load() is evicted, so the next compile retries and succeeds", async () => {
    let calls = 0;
    const tpl = defineTemplate({
      id: "flaky-loaded",
      title: "Flaky Loaded",
      type: "service",
      load: async () => {
        calls++;
        if (calls === 1) throw new Error("bakery offline");
        return { flavors: ["Vanilla"] };
      },
      parameters: (data) => [page("Cake", { flavor: p.enum(data.flavors, { required: true }) })],
      steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor } })],
    });
    await expect(compileResolved(tpl, nonprod)).rejects.toThrow("bakery offline");
    // The rejection was evicted from the per-env cache → this retries load().
    const { object } = await compileResolved(tpl, nonprod);
    expect(bakedFlavors(object)).toEqual(["Vanilla"]);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TYPE-INFERENCE PROOF — never executed; verified by `tsc --noEmit` (typecheck).
// `data` is the awaited load() result; `f` is inferred from the function-returned
// pages. A wrong data key and a wrong field name are `@ts-expect-error`s.
// ---------------------------------------------------------------------------

function _loadTypeProof(): void {
  defineTemplate({
    id: "proof",
    title: "proof",
    type: "service",
    load: async (_ctx: LoadContext) => ({ flavors: ["a"], sizes: ["b"] }),
    parameters: (data) => {
      const flavors: string[] = data.flavors;
      void flavors;
      // @ts-expect-error — the loaded data has no `colors`
      void data.colors;
      return [page("Cake", { flavor: p.enum(data.flavors), size: p.enum(data.sizes) })];
    },
    steps: (f) => {
      const flavorRef: Ref<string> = f.flavor;
      void flavorRef;
      // @ts-expect-error — `flavr` is not a field (names are inferred from the props)
      void f.flavr;
      return [step("order", "bakery:place", { input: { flavor: f.flavor, size: f.size } })];
    },
  });
}
void _loadTypeProof;
