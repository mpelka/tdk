// Param-model acceptance test for the synthetic `CustomCakeOrder` template.
//
// Asserts the compiled `spec.parameters` structure (pages, every `p.*` field
// shape, enum/enumNames/ui:*, the eq/oneOf/not dependencies + the NESTED one),
// the merged `extraSpec`, and that the whole entity passes the real Backstage
// schema `validate()`.

import { describe, expect, test } from "bun:test";
import type { PageObject } from "../index.ts";
import { compile, validate } from "../index.ts";
import { CustomCakeOrder } from "./cake-order-template.ts";
import { depTree } from "./entity-access.ts";

const target = { env: "test", outDir: "dist/test" } as const;

/** Compile once and pull `spec.parameters` (the page array) out. */
function pages(): PageObject[] {
  const { object } = compile(new CustomCakeOrder(), target);
  return object.spec.parameters as PageObject[];
}

describe("CustomCakeOrder — multi-page form shape", () => {
  test("emits a 4-page parameter array", () => {
    const p = pages();
    expect(Array.isArray(p)).toBe(true);
    expect(p).toHaveLength(4);
    expect(p.map((pg) => pg.title)).toEqual(["Order Details", "Bakery", "Cake", "Extras"]);
  });

  test("page-level required + ui:order are emitted", () => {
    const cake = pages()[2]!;
    expect(cake.required).toEqual(["tier", "flavour"]);
    expect(cake["ui:order"]).toEqual(["tier", "flavour", "filling", "box_finish", "gluten_free", "*"]);
  });
});

describe("CustomCakeOrder — every p.* helper compiles its schema", () => {
  test("base param types (string / number / boolean / enum / array)", () => {
    const p = pages();
    const order = p[0]!.properties;
    expect(order.order_name).toMatchObject({ type: "string", title: "Order reference" });
    expect(order.servings).toMatchObject({
      type: "number",
      minimum: 1,
      maximum: 200,
    });

    const cake = p[2]!.properties;
    expect(cake.gluten_free).toMatchObject({ type: "boolean", default: false });
    // p.enum → a string schema constrained by `enum`, with a placeholder.
    expect(cake.flavour).toMatchObject({
      type: "string",
      enum: ["Vanilla", "Chocolate", "Red Velvet"],
      "ui:placeholder": "Choose a flavour",
    });

    const extras = p[3]!.properties;
    expect(extras.allergens).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
  });

  test("custom field helpers emit the right ui:field + ui:options", () => {
    const p = pages();
    expect(p[0]!.properties.requested_by).toMatchObject({
      "ui:field": "BakerPicker",
      "ui:options": { prefillCurrentUser: true },
    });
    expect(p[1]!.properties.bakery).toMatchObject({
      "ui:field": "FlavorEntityPicker",
      "ui:options": { catalogFilter: { kind: "Bakery" } },
    });
    expect(p[1]!.properties.bakery_details).toMatchObject({
      type: "object",
      "ui:field": "OrderDetailsDisplay",
      "ui:options": {
        title: "Bakery Details",
        sourceField: "bakery",
        kind: "Bakery",
        displayFields: ["bakeryName", "headBaker", "city"],
      },
    });
    expect(p[3]!.properties.information).toMatchObject({
      "ui:field": "NoteDisplay",
      "ui:options": { template: expect.stringContaining("5 working days") },
    });
  });

  test("enum + enumNames + ui:widget + ui:options(rows) are emitted", () => {
    const p = pages();
    expect(p[2]!.properties.tier).toMatchObject({
      enum: ["Cupcakes", "Two Tier", "Three Tier"],
      enumNames: ["Cupcakes (24)", "Two Tier", "Three Tier"],
      "ui:widget": "radio",
    });
    // rush_reason is revealed by a dependency; its textarea rows live there.
    const extrasDeps = depTree(p[3]!).rush.oneOf;
    const rushBranch = extrasDeps.find((b) => b.properties.rush?.const === "Rush")!;
    expect(rushBranch.properties.rush_reason).toMatchObject({
      "ui:widget": "textarea",
      "ui:options": { rows: 3 },
    });
  });
});

describe("CustomCakeOrder — conditional dependencies", () => {
  test("dep.eq reveals a field on a matching value (gift_wrap → gift_message)", () => {
    const bakery = pages()[1]!;
    const branches = depTree(bakery).gift_wrap.oneOf;
    const yes = branches.find((b) => b.properties.gift_wrap?.const === "Yes")!;
    const no = branches.find((b) => b.properties.gift_wrap?.const === "No")!;
    expect(yes.properties.gift_message).toBeDefined();
    expect(yes.required).toEqual(["gift_message"]);
    expect(no.properties.gift_message).toBeUndefined();
  });

  test("dep.oneOf matches a set of values via `enum`", () => {
    const cake = pages()[2]!;
    const branches = depTree(cake).tier.oneOf;
    const tiered = branches.find((b) => Array.isArray(b.properties.tier?.enum))!;
    expect(tiered.properties.tier!.enum).toEqual(["Two Tier", "Three Tier"]);
    expect(tiered.properties.filling).toBeDefined();
  });

  test("a NESTED dependency (tier → box_finish → box_note) round-trips, incl. dep.not", () => {
    const cake = pages()[2]!;
    const cupcakes = depTree(cake).tier.oneOf.find((b) => b.properties.tier?.const === "Cupcakes")!;
    expect(cupcakes.properties.box_finish).toBeDefined();

    const nested = cupcakes.dependencies!.box_finish.oneOf;
    const custom = nested.find((b) => b.properties.box_finish?.const === "Custom")!;
    expect(custom.properties.box_note).toBeDefined();
    expect(custom.required).toEqual(["box_note"]);

    // dep.not("Custom") → `{ not: { const: "Custom" } }`
    const notCustom = nested.find((b) => b.properties.box_finish?.not)!;
    expect(notCustom.properties.box_finish!.not).toEqual({ const: "Custom" });
  });
});

describe("CustomCakeOrder — spec + validation", () => {
  test("extraSpec is merged as top-level spec keys", () => {
    const { object } = compile(new CustomCakeOrder(), target);
    // `spec` carries an index signature for extraSpec keys — no cast needed.
    expect(object.spec.catalog_metadata).toEqual({
      category: "Catering",
      lead_time_days: "5",
      fulfilment_team: "Partner Bakery Network",
    });
    expect(object.spec.owner).toBe("team-bakery");
  });

  test("the compiled entity passes the real Backstage schema", async () => {
    const { object } = compile(new CustomCakeOrder(), target);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});
