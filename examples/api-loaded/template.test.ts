// Tests for the Storefront Flavour Picker — a REAL-network load() template.
//
// Two tiers, both here:
//
//   FIXTURE TIER (hermetic, deterministic) — inject the catalog via `loaded`, so
//   load()'s fetch never runs. This is what `tdk test` snapshots use. The compiled
//   TEST and PROD artifacts are diffed against their own hand-written golds, proving
//   the prod-only pistachio-royale never reaches the test artifact.
//
//   MOCK-SERVER TIER (the recipe this example exists for) — spin a local `Bun.serve`
//   catalog on an ephemeral port, point the injectable base URL at it, and run the
//   REAL load() path (compileResolved for both envs). This proves the fetch → parse →
//   bake pipeline end-to-end, hermetically, with zero new dependencies. Swap the
//   startMockCatalog helper for msw's setupServer if your components already
//   standardise on msw — the recipe (inject base URL, serve per-env catalogs, compile
//   both, assert, tear down) is identical.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertExecuteAgainstGold,
  assertValid,
  compileAll,
  compileResolved,
  type PageObject,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { CATALOGS, type MockCatalog, startMockCatalog } from "./__fixtures__/mock-catalog.ts";
import { StorefrontFlavourPicker } from "./template.ts";

const testTarget = { env: "test", outDir: "" } as const;
const prodTarget = { env: "prod", outDir: "" } as const;
const nonprodGold = readFileSync(new URL("./gold-standard.nonprod.yaml", import.meta.url), "utf8");
const prodGold = readFileSync(new URL("./gold-standard.prod.yaml", import.meta.url), "utf8");

/** The featuredFlavour enum from a compiled entity's first (only) page. */
function flavourEnum(object: { spec: { parameters: unknown } }): string[] {
  const [storefrontPage] = object.spec.parameters as PageObject[];
  return (storefrontPage!.properties.featuredFlavour as { enum: string[] }).enum;
}

// ---------------------------------------------------------------------------------
// FIXTURE TIER — inject `loaded`, so load()'s fetch never runs. Deterministic.
// ---------------------------------------------------------------------------------

describe("storefront-flavour-picker — fixture tier (loaded injected, no fetch)", () => {
  const testCatalog = { flavours: CATALOGS.test };
  const prodCatalog = { flavours: CATALOGS.prod };

  test("the TEST artifact bakes vanilla + chocolate ONLY", async () => {
    const { object, yaml } = await compileResolved(StorefrontFlavourPicker, testTarget, {
      loaded: testCatalog,
    });
    expect(flavourEnum(object)).toEqual(["vanilla", "chocolate"]);
    // The prod-only flavour must NOT appear anywhere in the test artifact.
    expect(yaml).not.toContain("pistachio-royale");
  });

  test("the PROD artifact bakes vanilla + chocolate + pistachio-royale", async () => {
    const { object } = await compileResolved(StorefrontFlavourPicker, prodTarget, {
      loaded: prodCatalog,
    });
    expect(flavourEnum(object)).toEqual(["vanilla", "chocolate", "pistachio-royale"]);
  });

  test("the env.pick storefront shelf differs per target", async () => {
    const test = await compileResolved(StorefrontFlavourPicker, testTarget, { loaded: testCatalog });
    const prod = await compileResolved(StorefrontFlavourPicker, prodTarget, { loaded: prodCatalog });
    const shelfOf = (o: typeof test.object) => (o.spec.steps[0]!.input as { shelf: string }).shelf;
    expect(shelfOf(test.object)).toBe("test-shelf");
    expect(shelfOf(prod.object)).toBe("prod-shelf");
  });

  test("the compiled TEST + PROD entities are schema-valid", async () => {
    const test = await compileResolved(StorefrontFlavourPicker, testTarget, { loaded: testCatalog });
    const prod = await compileResolved(StorefrontFlavourPicker, prodTarget, { loaded: prodCatalog });
    await assertValid(test.object);
    await assertValid(prod.object);
  });

  test("both hand-written golds are schema-valid", async () => {
    for (const gold of [nonprodGold, prodGold]) {
      const { valid, errors } = await validate(parse(gold));
      if (!valid) console.error(errors);
      expect(valid).toBe(true);
    }
  });

  test("a TEST run agrees with the nonprod gold", async () => {
    await assertExecuteAgainstGold(
      StorefrontFlavourPicker,
      nonprodGold,
      {
        loaded: testCatalog,
        parameters: { featuredFlavour: "vanilla", headline: "Fresh vanilla" },
        steps: { publish: { output: { url: "u" } } },
      },
      { target: testTarget },
    );
  });

  test("a PROD run (pistachio-royale + prod-shelf) agrees with the prod gold", async () => {
    await assertExecuteAgainstGold(
      StorefrontFlavourPicker,
      prodGold,
      {
        loaded: prodCatalog,
        parameters: { featuredFlavour: "pistachio-royale", headline: "Limited pistachio royale" },
        steps: { publish: { output: { url: "u" } } },
      },
      { target: prodTarget },
    );
  });
});

// ---------------------------------------------------------------------------------
// MOCK-SERVER TIER — the recipe. Spin a local catalog, run the REAL load() fetch.
// ---------------------------------------------------------------------------------
//
// A fresh template instance is compiled per env against the local mock. Each test
// imports the module dynamically with a unique query suffix AFTER pointing
// BAKERY_MENU_API at the mock — a fresh module means an empty per-env load() cache, so
// the real fetch runs. The mock binds port 0 (ephemeral), so parallel test files never
// collide.

describe("storefront-flavour-picker — mock-server tier (REAL load() fetch)", () => {
  let mock: MockCatalog;
  const previousBaseUrl = process.env.BAKERY_MENU_API;

  beforeAll(() => {
    mock = startMockCatalog();
    // Point the template's injectable base URL at the ephemeral mock origin.
    process.env.BAKERY_MENU_API = mock.origin;
  });

  afterAll(() => {
    mock.stop();
    // Restore the env var so no state leaks to other test files.
    if (previousBaseUrl === undefined) {
      delete process.env.BAKERY_MENU_API;
    } else {
      process.env.BAKERY_MENU_API = previousBaseUrl;
    }
  });

  test("load() fetches each env's catalog and bakes different options", async () => {
    // Re-import the template fresh (unique query) so its per-env load() cache is empty
    // and the real fetch runs for both envs against the mock.
    const { StorefrontFlavourPicker: freshTemplate } = await import(`./template.ts?mock=${mock.origin}`);

    const test = await compileResolved(freshTemplate, testTarget);
    const prod = await compileResolved(freshTemplate, prodTarget);

    // The baked options came over a real HTTP round-trip and differ per env.
    expect(flavourEnum(test.object)).toEqual(["vanilla", "chocolate"]);
    expect(flavourEnum(prod.object)).toEqual(["vanilla", "chocolate", "pistachio-royale"]);
    expect(test.yaml).not.toContain("pistachio-royale");

    // Both envs were actually fetched over the wire.
    expect(mock.requestedPaths).toContain("/api/test/flavours");
    expect(mock.requestedPaths).toContain("/api/prod/flavours");
  });

  test("compileAll drives the real load() once per target", async () => {
    const { StorefrontFlavourPicker: freshTemplate } = await import(`./template.ts?mock=${mock.origin}-all`);
    const jobs = await compileAll([freshTemplate], { nonprod: testTarget, prod: prodTarget }, { write: false });
    expect(jobs.map((j) => j.targetName).sort()).toEqual(["nonprod", "prod"]);
    const byTarget = Object.fromEntries(jobs.map((j) => [j.targetName, j.result.object]));
    expect(flavourEnum(byTarget.nonprod!)).not.toContain("pistachio-royale");
    expect(flavourEnum(byTarget.prod!)).toContain("pistachio-royale");
  });

  test("a fetch failure surfaces as a load() error", async () => {
    const { load } = await import(`./template.ts?mock=${mock.origin}-fail`);
    // "staging" has no catalog on the mock, so the endpoint 404s and load() throws.
    await expect(load({ env: "staging" })).rejects.toThrow(/menu catalog fetch failed for env "staging": 404/);
  });
});
