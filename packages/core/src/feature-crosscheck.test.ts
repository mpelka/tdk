// Feature cross-check: prove core's feature batch can express a representative
// real-world template SHAPE end to end — every parameter-form and ${{ }} /
// roadie-jsonata construct a production template uses must be expressible here.
// The domain is the synthetic "custom cake order" used elsewhere in the fixtures;
// it deliberately reproduces no real template, only the structural constructs
// (`nj()`, `jsonata()`, and the parameter form) such a template exercises. Each
// test pins the compiled output (or proves render-/value-equivalence where the
// compiled form is cosmetically different but identical at runtime).

import { beforeEach, describe, expect, test } from "bun:test";
import { depTree } from "./__fixtures__/entity-access.ts";
import type { PageObject } from "./index.ts";
import {
  _resetEnvRegistry,
  compile,
  differentialNj,
  jsonata,
  nj,
  p,
  page,
  substringAfter,
  Template,
  validate,
} from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;
beforeEach(() => _resetEnvRegistry());

describe("nj() covers the ${{ }} interpolations", () => {
  test("data: ${{ user }}", () => {
    expect(nj((c) => c.user).toString()).toBe("${{ user }}");
  });

  test("${{ parameters.requested_by }}", () => {
    expect(nj((c) => c.parameters.requested_by).toString()).toBe("${{ parameters.requested_by }}");
  });

  test("${{ user.entity.metadata.name or steps['...'].output.result | upper }}", () => {
    const e = nj((c) => c.user.entity.metadata.name || c.steps["customer-id-fetch"].output.result.toUpperCase());
    // Source: `user.entity.metadata.name or steps['customer-id-fetch'].output.result | upper`
    // Compiled adds grouping parens (and double-quotes the step id) — same Jinja parse.
    expect(e.toString()).toBe('${{ (user.entity.metadata.name or steps["customer-id-fetch"].output.result | upper) }}');
  });

  test('${{ parameters.delivery_date or "" }} — plain or form', () => {
    const e = nj<{ parameters: { delivery_date?: string } }>((c) => c.parameters.delivery_date || "");
    // `x || ""` maps straight to Nunjucks `or` (which IS value-returning).
    expect(e.nunjucks).toBe('(parameters.delivery_date or "")');
    // ...but it renders IDENTICALLY to the `or ""` form on every input.
    const r = differentialNj(e, [
      { parameters: { delivery_date: "2026-01-01T09:00" } },
      { parameters: { delivery_date: "" } },
      { parameters: {} },
    ]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["2026-01-01T09:00", "", ""]);
  });
});

describe("jsonata() covers the roadie:jsonata expressions", () => {
  test('$substringAfter(ref, "user:default/")', () => {
    expect(jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/")).jsonata).toBe(
      '$substringAfter(ref, "user:default/")',
    );
  });

  test("the order-summary object (& concat via template literals) is expressible", () => {
    // A compute-order-summary step's expression — `data` is the JSONata root.
    type OrderData = {
      bakery: string;
      cakeSize: string;
      requestedBy: string;
    };
    const e = jsonata<OrderData>((c) => ({
      summary: `CAKE ORDER - ${c.bakery} - ${c.cakeSize}`,
    }));
    // The compact canonical emission (the pretty rendering wraps long objects).
    expect(e.compact).toBe('{"summary": ("CAKE ORDER - " & (bakery) & " - " & (cakeSize))}');
  });
});

describe("parameter form covers the cake-order fields", () => {
  class OrderParams extends Template {
    id = "order-params";
    title = "Cake order params";
    type = "Infrastructure Service";

    requestedBy = p.customField({
      type: "string",
      title: "Order placed by",
      uiField: "BakerPicker",
      uiOptions: { prefillCurrentUser: true },
      required: true,
    });
    deliveryDate = p.string({ title: "Delivery date", uiWidget: "datetime" });
    bakery = p.customField({
      title: "Bakery",
      required: true,
      uiField: "CakePickerWithDefault",
      uiOptions: {
        placeholder: "Select bakery...",
        path: "bakery-catalog/entities?filter=kind=Bakery",
        arraySelector: "",
        valueSelector: "metadata.name",
        labelSelector: "metadata.name",
      },
    });
    cakeSize = p.string({
      title: "Cake size",
      uiPlaceholder: "Please select a cake size",
      enum: ["SMALL", "MEDIUM", "LARGE"],
      enumNames: ["Small (6 inch)", "Medium (8 inch)", "Large (10 inch)"],
      required: true,
    });
    specialInstructions = p.string({
      title: "Special instructions",
      minLength: 1,
      maxLength: 75,
      uiWidget: "textarea",
      uiOptions: { rows: 2 },
      required: true,
    });
    wantsCandles = p.boolean({ title: "Add birthday candles", default: false });
    candlesNote = p.customField({
      type: "string",
      title: "Note",
      uiField: "NoteDisplay",
      uiOptions: { template: '<span style="color: #e65100;"><b>Note:</b> Candles are added at collection.</span>' },
      showWhen: { wantsCandles: true },
    });

    pages = [
      page({
        title: "Order Details",
        properties: {
          requested_by: this.requestedBy,
          delivery_date: this.deliveryDate,
          bakery: this.bakery,
          cake_size: this.cakeSize,
        },
      }),
      page({
        title: "Extras",
        uiOrder: ["special_instructions", "wantsCandles", "candlesNote", "*"],
        properties: {
          special_instructions: this.specialInstructions,
          wantsCandles: this.wantsCandles,
          candlesNote: this.candlesNote,
        },
      }),
    ];

    build() {
      return [
        {
          id: "customer-id-fetch",
          action: "roadiehq:utils:jsonata",
          input: {
            data: nj((c) => c.user),
            // `.jsonata` is a STRING — the roadie action's `expression:` field
            // evaluates it as JSONata. (Passing the OBJECT would render
            // `${{ <jsonata> }}`, which compile rejects — see compile.ts #30.)
            expression: jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/")).jsonata,
          },
        },
      ];
    }
  }

  test("CakePickerWithDefault custom field emits verbatim ui:field + ui:options", () => {
    const [pg1] = compile(new OrderParams(), nonprod).object.spec.parameters as PageObject[];
    expect(pg1!.properties.bakery).toEqual({
      type: "string",
      title: "Bakery",
      "ui:field": "CakePickerWithDefault",
      "ui:options": {
        placeholder: "Select bakery...",
        path: "bakery-catalog/entities?filter=kind=Bakery",
        arraySelector: "",
        valueSelector: "metadata.name",
        labelSelector: "metadata.name",
      },
    });
  });

  test("minLength/maxLength emitted; wantsCandles boolean dependency via showWhen", () => {
    const pages = compile(new OrderParams(), nonprod).object.spec.parameters as PageObject[];
    const extras = pages[1]!;
    expect(extras.properties.special_instructions).toMatchObject({
      minLength: 1,
      maxLength: 75,
    });
    expect(depTree(extras).wantsCandles.oneOf).toEqual([
      {
        properties: {
          wantsCandles: { const: true },
          candlesNote: {
            type: "string",
            title: "Note",
            "ui:field": "NoteDisplay",
            "ui:options": {
              template: '<span style="color: #e65100;"><b>Note:</b> Candles are added at collection.</span>',
            },
          },
        },
      },
      { properties: { wantsCandles: { const: false } } },
    ]);
  });

  test("the whole compiled cake-order-shaped entity validates", async () => {
    const { object } = compile(new OrderParams(), nonprod);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});
