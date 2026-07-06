// Tests for the field/action authoring hooks (extend.ts) and how they compose
// with the resolver + action-simulator hooks. The end-to-end block uses a
// SYNTHETIC bakery plugin that imports ONLY the public barrel, proving all three
// extension hooks compose without core importing the plugin.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
// The synthetic consumer plugin — exercised by the end-to-end block below. It
// imports ONLY from the public barrel (asserted at the bottom of this file).
import { cakeDecorator, flavorPicker, installBakery, registerOrder } from "./__fixtures__/plugin-bakery/index.ts";
import type { Step } from "./index.ts";
import {
  _resetActionSimulators,
  _resetEnvRegistry,
  _resetResolvers,
  compile,
  compileResolved,
  defineAction,
  defineField,
  execute,
  getActionSimulator,
  raw,
  Template,
} from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

// Every registry is reset before each test so a definition in one test never
// leaks into the next. The end-to-end block re-installs the bakery plugin after
// this reset (its own nested beforeEach).
beforeEach(() => {
  _resetResolvers();
  _resetActionSimulators();
  _resetEnvRegistry();
});

describe("defineField", () => {
  // A field helper mapping a small option set onto p.customField.
  const ratingField = defineField((o: { catalog: string; title?: string; required?: boolean }) => ({
    title: o.title,
    required: o.required,
    uiField: "StarRating",
    uiOptions: { path: o.catalog },
  }));

  test("produces a Param whose compiled schema carries ui:field/ui:options/title", () => {
    class HasField extends Template {
      id = "has-field";
      title = "Has Field";
      type = "service";
      params = {
        rating: ratingField({
          catalog: "bakery/ratings",
          title: "Rating",
          required: true,
        }),
      };
      build(): Step[] {
        return [];
      }
    }

    const { object } = compile(new HasField(), nonprod);
    const params = object.spec.parameters as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const prop = params.properties.rating!;
    expect(prop["ui:field"]).toBe("StarRating");
    expect(prop["ui:options"]).toEqual({ path: "bakery/ratings" });
    expect(prop.title).toBe("Rating");
    // `required` is collected into the schema's required array, not emitted inline.
    expect(params.required).toContain("rating");
    expect(prop.required).toBeUndefined();
  });

  test("a helper without `required` omits the field from `required`", () => {
    class Optional extends Template {
      id = "optional";
      title = "Optional";
      type = "service";
      params = { rating: ratingField({ catalog: "bakery/ratings" }) };
      build(): Step[] {
        return [];
      }
    }
    const { object } = compile(new Optional(), nonprod);
    const params = object.spec.parameters as { required?: string[] };
    expect(params.required).toBeUndefined();
  });
});

describe("defineAction", () => {
  test("yields a Step with action + the built id/input", () => {
    const ship = defineAction({
      action: "bakery:ship",
      build: (a: { id: string; to: string }) => ({
        id: a.id,
        input: { to: a.to },
      }),
    });
    expect(ship({ id: "ship-it", to: "Oslo" })).toEqual({
      action: "bakery:ship",
      id: "ship-it",
      input: { to: "Oslo" },
    });
  });

  test("registers an ActionSimulator when `simulate` is provided", () => {
    expect(getActionSimulator("bakery:ship")).toBeUndefined();
    defineAction({
      action: "bakery:ship",
      build: (a: { id: string }) => ({ id: a.id }),
      simulate: (input) => ({ tracking: `trk-${input.to}` }),
    });
    expect(getActionSimulator("bakery:ship")).toBeDefined();
  });

  test("registers nothing when `simulate` is omitted", () => {
    defineAction({
      action: "bakery:nosim",
      build: (a: { id: string }) => ({ id: a.id }),
    });
    expect(getActionSimulator("bakery:nosim")).toBeUndefined();
  });
});

describe("execute() with a custom action simulator", () => {
  test("an explicit fixture mock OUTRANKS a registered simulator (mock-wins)", async () => {
    // MOCK-WINS (#26): the same step has BOTH a registered simulator AND an
    // explicit fixture mock. The mock is the author's intent for THIS scenario
    // — specific beats general — so it takes precedence and the simulator is not
    // consulted. This is the only way to pin an edge/error shape the simulator
    // can't produce.
    const placeOrder = defineAction({
      action: "bakery:placeOrder",
      build: (a: { flavor: string }) => ({
        id: "place",
        input: { flavor: a.flavor },
      }),
      simulate: (input) => ({ body: `order:${input.flavor}` }),
    });

    class Order extends Template {
      id = "order";
      title = "Order";
      type = "service";
      params = {};
      build(): Step[] {
        return [placeOrder({ flavor: "ganache" })];
      }
    }

    const { steps } = await execute(new Order(), {
      parameters: {},
      steps: { place: { output: { body: "MOCK-WINS" } } },
    });
    // The explicit mock wins over the simulator's computed answer.
    expect(steps.place!.output).toEqual({ body: "MOCK-WINS" });
  });

  test("the simulator runs when NO mock is supplied for its step", async () => {
    // The other half of mock-wins: with no fixture mock, the registered
    // simulator is the source of truth (computed from the rendered input).
    const placeOrder = defineAction({
      action: "bakery:placeOrder",
      build: (a: { flavor: string }) => ({
        id: "place",
        input: { flavor: a.flavor },
      }),
      simulate: (input) => ({ body: `order:${input.flavor}` }),
    });

    class Order extends Template {
      id = "order";
      title = "Order";
      type = "service";
      params = {};
      build(): Step[] {
        return [placeOrder({ flavor: "ganache" })];
      }
    }

    // No `steps` mock → the simulator computes the output from input "ganache".
    const { steps } = await execute(new Order(), { parameters: {} });
    expect(steps.place!.output).toEqual({ body: "order:ganache" });
  });

  test("falls back to the fixture mock when NO simulator is registered", async () => {
    class Fetch extends Template {
      id = "fetch";
      title = "Fetch";
      type = "service";
      params = {};
      build(): Step[] {
        return [{ id: "fetch", action: "http:backstage:request", input: {} }];
      }
    }
    // No simulator for "http:backstage:request" → existing mock behaviour holds.
    const { steps } = await execute(new Fetch(), {
      parameters: {},
      steps: { fetch: { output: { status: 200 } } },
    });
    expect(steps.fetch!.output).toEqual({ status: 200 });
  });

  test("an async simulator is awaited", async () => {
    const slow = defineAction({
      action: "bakery:slow",
      build: () => ({ id: "slow", input: {} }),
      simulate: async () => {
        await Promise.resolve();
        return { ready: true };
      },
    });
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      params = {};
      build(): Step[] {
        return [slow({})];
      }
    }
    const { steps } = await execute(new T(), { parameters: {} });
    expect(steps.slow!.output).toEqual({ ready: true });
  });
});

// END-TO-END: all three hooks (resolver + field + action/simulator) via the
// bakery plugin. The plugin registers at import; the outer beforeEach clears the
// registries, so this block RE-INSTALLS the plugin (same stable refs) first.
describe("all three hooks compose (bakery plugin)", () => {
  beforeEach(() => {
    installBakery();
  });

  class CakeOrderRequest extends Template {
    id = "cake-order-request";
    title = "Cake Order Request";
    type = "service";
    // HOOK B (field): a custom flavor picker.
    params = {
      flavor: flavorPicker({
        catalog: "bakery/flavors",
        title: "Flavour",
        required: true,
      }),
    };
    build(): Step[] {
      // HOOK B (action) + HOOK C (simulator): registerOrder yields the step and
      // its `simulate` is what execute() runs for it.
      return [registerOrder({ id: "register", flavor: this.params.flavor.ref })];
    }
    // HOOK A (resolver): the decorator marker is resolved to a bakery id.
    output = {
      decorator: cakeDecorator("Ada Lovelace"),
      body: raw`\${{ steps.register.output.body }}`,
    };
  }

  test("compileResolved bakes the resolved decorator id + the custom field into the YAML", async () => {
    const { object, yaml } = await compileResolved(new CakeOrderRequest(), nonprod);

    // HOOK A: the marker never reaches the artifact; only the resolved id does.
    expect(object.spec.output!.decorator).toBe("deco-ada");
    expect(yaml).toContain("deco-ada");
    expect(parse(yaml).spec.output.decorator).toBe("deco-ada");

    // HOOK B (field): the custom field compiled to its ui:field/ui:options.
    const params = object.spec.parameters as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(params.properties.flavor!["ui:field"]).toBe("FlavorPicker");
    expect(params.properties.flavor!["ui:options"]).toEqual({
      path: "bakery/flavors",
    });
    expect(params.required).toContain("flavor");
  });

  test("execute flows the SIMULATED action output (and resolved id) through", async () => {
    const { steps, output } = await execute(new CakeOrderRequest(), {
      parameters: { flavor: "ganache" },
    });

    // HOOK C: the register step's output came from the SIMULATOR — computed from
    // the rendered `flavor` input — with NO fixture mock supplied for it.
    expect(steps.register!.output).toEqual({
      body: "order:ganache",
      link: "https://bakery.example/orders/ganache",
    });
    // The resolved decorator id (Hook A) and the simulated body (Hook C) both
    // flow into the rendered output.
    expect(output).toEqual({ decorator: "deco-ada", body: "order:ganache" });
  });

  test("the bakery plugin imports ONLY the public barrel", async () => {
    const src = await readFile(new URL("./__fixtures__/plugin-bakery/index.ts", import.meta.url), "utf8");
    const specifiers = [...src.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).toBe("../../index.ts");
    }
  });
});
