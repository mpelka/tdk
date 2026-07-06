// Tests for the Seasonal Menu Publisher.
//
// A load() + env template, so the tests compile BOTH targets (compileResolved /
// compileAll) and diff each against its OWN hand-written gold. The invariants:
//   (a) the prod-only enum value appears ONLY in the prod artifact (env safety),
//   (b) restrictedToUsers is emitted while beta,
//   (c) the extraSpec key passes through verbatim.
// Both compiled entities AND both golds are schema-validated.

import { describe, expect, test } from "bun:test";
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
import { SeasonalMenuPublisher } from "./template.ts";

const testTarget = { env: "test", outDir: "" } as const;
const prodTarget = { env: "prod", outDir: "" } as const;
const nonprodGold = readFileSync(new URL("./gold-standard.nonprod.yaml", import.meta.url), "utf8");
const prodGold = readFileSync(new URL("./gold-standard.prod.yaml", import.meta.url), "utf8");

/** The featuredFlavour enum from a compiled entity's first (only) page. */
function flavourEnum(object: { spec: { parameters: unknown } }): string[] {
  const [menuPage] = object.spec.parameters as PageObject[];
  return (menuPage!.properties.featuredFlavour as { enum: string[] }).enum;
}

describe("seasonal-menu-publisher — env-loaded menu (invariant a)", () => {
  test("the TEST artifact bakes vanilla + chocolate ONLY", async () => {
    const { object, yaml } = await compileResolved(SeasonalMenuPublisher, testTarget);
    expect(flavourEnum(object)).toEqual(["vanilla", "chocolate"]);
    // The prod-only flavour must NOT appear anywhere in the test artifact.
    expect(yaml).not.toContain("pistachio-royale");
  });

  test("the PROD artifact bakes vanilla + chocolate + pistachio-royale", async () => {
    const { object } = await compileResolved(SeasonalMenuPublisher, prodTarget);
    expect(flavourEnum(object)).toEqual(["vanilla", "chocolate", "pistachio-royale"]);
  });

  test("the env.pick oven cluster differs per target", async () => {
    const test = await compileResolved(SeasonalMenuPublisher, testTarget);
    const prod = await compileResolved(SeasonalMenuPublisher, prodTarget);
    const clusterOf = (o: typeof test.object) => (o.spec.steps[0]!.input as { cluster: string }).cluster;
    expect(clusterOf(test.object)).toBe("test-oven");
    expect(clusterOf(prod.object)).toBe("prod-oven");
  });
});

describe("seasonal-menu-publisher — lifecycle + extraSpec (invariants b, c)", () => {
  test("restrictedToUsers is emitted in BOTH artifacts (beta)", async () => {
    const test = await compileResolved(SeasonalMenuPublisher, testTarget);
    const prod = await compileResolved(SeasonalMenuPublisher, prodTarget);
    expect(test.object.spec.restrictedToUsers).toEqual(["baker-042"]);
    expect(prod.object.spec.restrictedToUsers).toEqual(["baker-042"]);
  });

  test("the extraSpec key passes through VERBATIM", async () => {
    const { object } = await compileResolved(SeasonalMenuPublisher, testTarget);
    expect(object.spec.bakery_catalogue_metadata).toEqual({
      category_L1: "Signature Bakes",
      refresh_cadence: "weekly",
    });
  });
});

describe("seasonal-menu-publisher — compileAll writes both targets", () => {
  test("one job per target, each with its env-specific menu", async () => {
    // compileAll with write off (we only assert the results, not disk).
    const jobs = await compileAll([SeasonalMenuPublisher], { nonprod: testTarget, prod: prodTarget }, { write: false });
    expect(jobs.map((j) => j.targetName).sort()).toEqual(["nonprod", "prod"]);
    const byTarget = Object.fromEntries(jobs.map((j) => [j.targetName, j.result.object]));
    expect(flavourEnum(byTarget.nonprod!)).not.toContain("pistachio-royale");
    expect(flavourEnum(byTarget.prod!)).toContain("pistachio-royale");
  });
});

describe("seasonal-menu-publisher — schema validity (both artifacts + both golds)", () => {
  test("the compiled TEST + PROD entities are schema-valid", async () => {
    const test = await compileResolved(SeasonalMenuPublisher, testTarget);
    const prod = await compileResolved(SeasonalMenuPublisher, prodTarget);
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
});

describe("seasonal-menu-publisher — whole-run agreement vs the golds", () => {
  const testMenu = { flavours: ["vanilla", "chocolate"] };
  const prodMenu = { flavours: ["vanilla", "chocolate", "pistachio-royale"] };

  test("a TEST run agrees with the nonprod gold", async () => {
    await assertExecuteAgainstGold(
      SeasonalMenuPublisher,
      nonprodGold,
      {
        loaded: testMenu,
        parameters: { featuredFlavour: "vanilla", headline: "Fresh vanilla" },
        steps: { publish: { output: { url: "u" } } },
      },
      { target: testTarget },
    );
  });

  test("a PROD run (pistachio-royale + prod-oven) agrees with the prod gold", async () => {
    await assertExecuteAgainstGold(
      SeasonalMenuPublisher,
      prodGold,
      {
        loaded: prodMenu,
        parameters: { featuredFlavour: "pistachio-royale", headline: "Limited pistachio royale" },
        steps: { publish: { output: { url: "u" } } },
      },
      { target: prodTarget },
    );
  });
});
