// A synthetic, multi-page template that exercises the rich PARAM MODEL — invented
// "custom cake order" domain, reproducing no real-world template, only the
// structural features the param model must express:
//
//   - `pages` / `page(...)` (a 4-page conditional form),
//   - the `p.*` base helpers: string, number, boolean, enum, array, plus
//     `p.customField` standing in for custom field types (synthetic ui:field
//     names BakerPicker / FlavorEntityPicker / OrderDetailsDisplay / NoteDisplay),
//   - `enum` + `enumNames`, and the `ui:*` family (widget / placeholder / options
//     / field via the custom helpers),
//   - `dep.when` / `eq` / `oneOf` / `not`, including a NESTED dependency
//     (tier → box finish → box note),
//   - `extraSpec` (custom top-level spec keys).
//
// The colocated `.test.ts` asserts the compiled structure and that the entity
// passes the real Backstage schema `validate()`.

import type { Step } from "../index.ts";
import { dep, p, page, Template } from "../index.ts";

export class CustomCakeOrder extends Template {
  id = "custom-cake-order";
  title = "Custom Cake Order";
  description = "Order a custom cake from a partner bakery.";
  type = "service";
  tags = ["cake", "order", "bakery"];
  owner = "team-bakery";

  // Custom top-level spec keys TDK doesn't otherwise model.
  extraSpec = {
    catalog_metadata: {
      category: "Catering",
      lead_time_days: "5",
      fulfilment_team: "Partner Bakery Network",
    },
  };

  // --- Page 1: Order Details ---
  requestedBy = p.customField({
    type: "string",
    title: "Order placed by",
    uiField: "BakerPicker",
    uiOptions: { prefillCurrentUser: true },
    required: true,
  });
  orderName = p.string({
    title: "Order reference",
    description: "A short name to identify this order. Example: smith-wedding.",
    required: true,
  });
  servings = p.number({
    title: "Number of servings",
    minimum: 1,
    maximum: 200,
    required: true,
  });

  // --- Page 2: Bakery ---
  bakery = p.customField({
    type: "string",
    title: "Bakery",
    uiField: "FlavorEntityPicker",
    uiOptions: { catalogFilter: { kind: "Bakery" } },
    required: true,
  });
  bakeryDetails = p.customField({
    type: "object",
    uiField: "OrderDetailsDisplay",
    uiOptions: {
      title: "Bakery Details",
      sourceField: "bakery",
      kind: "Bakery",
      displayFields: ["bakeryName", "headBaker", "city"],
    },
  });
  giftWrap = p.string({
    title: "Gift wrap the order?",
    enum: ["Yes", "No"],
    uiWidget: "radio",
    required: true,
  });
  giftMessage = p.string({
    title: "Gift message",
    description: "Printed on the gift card.",
    uiWidget: "textarea",
    uiOptions: { rows: 3 },
    required: true,
  });

  // --- Page 3: Cake ---
  tier = p.string({
    title: "Tier",
    description: "How the cake is built.",
    enum: ["Cupcakes", "Two Tier", "Three Tier"],
    enumNames: ["Cupcakes (24)", "Two Tier", "Three Tier"],
    uiWidget: "radio",
    required: true,
  });
  flavour = p.enum({
    title: "Flavour",
    enum: ["Vanilla", "Chocolate", "Red Velvet"],
    uiPlaceholder: "Choose a flavour",
    required: true,
  });
  glutenFree = p.boolean({
    title: "Gluten free?",
    default: false,
  });
  filling = p.string({
    title: "Filling",
    uiPlaceholder: "Choose a filling",
    enum: ["Buttercream", "Ganache", "Fruit"],
    required: true,
  });
  boxFinish = p.string({
    title: "Box finish",
    enum: ["Standard", "Custom"],
    uiWidget: "radio",
    required: true,
  });
  boxNote = p.string({
    title: "Custom box note",
    description: "Describe the custom box finish.",
    uiWidget: "textarea",
    uiOptions: { rows: 2 },
    required: true,
  });

  // --- Page 4: Extras ---
  information = p.customField({
    type: "string",
    title: "Information",
    uiField: "NoteDisplay",
    uiOptions: {
      template: "Standard orders are ready in 5 working days. A deposit is taken on confirmation.",
    },
  });
  allergens = p.array({
    title: "Allergen notes",
    description: "List any allergens the kitchen must avoid.",
    items: { type: "string" },
  });
  rush = p.string({
    title: "Delivery speed",
    enum: ["Standard", "Rush"],
    enumNames: ["Standard (5 days)", "Rush (24h)"],
    uiWidget: "radio",
    default: "Standard",
    required: true,
  });
  rushWarning = p.customField({
    type: "string",
    title: "Warning",
    uiField: "NoteDisplay",
    uiOptions: {
      template: '<div style="color:#b00">Rush orders incur a surcharge and cannot be cancelled.</div>',
    },
  });
  rushReason = p.string({
    title: "Reason for the rush order",
    uiWidget: "textarea",
    uiOptions: { rows: 3 },
    required: true,
  });

  pages = [
    page({
      title: "Order Details",
      properties: {
        requested_by: this.requestedBy,
        order_name: this.orderName,
        servings: this.servings,
      },
    }),

    page({
      title: "Bakery",
      properties: {
        bakery: this.bakery,
        bakery_details: this.bakeryDetails,
        gift_wrap: this.giftWrap,
      },
      dependencies: [
        dep.when(this.giftWrap, [
          dep.eq("Yes", {
            properties: { gift_message: this.giftMessage },
          }),
          dep.eq("No"),
        ]),
      ],
    }),

    page({
      title: "Cake",
      uiOrder: ["tier", "flavour", "filling", "box_finish", "gluten_free", "*"],
      properties: {
        tier: this.tier,
        flavour: this.flavour,
        gluten_free: this.glutenFree,
      },
      dependencies: [
        dep.when(this.tier, [
          dep.oneOf(["Two Tier", "Three Tier"], {
            properties: { filling: this.filling },
          }),
          dep.eq("Cupcakes", {
            properties: { box_finish: this.boxFinish },
            dependencies: [
              dep.when(this.boxFinish, [
                dep.eq("Custom", {
                  properties: { box_note: this.boxNote },
                }),
                dep.not("Custom"),
              ]),
            ],
          }),
        ]),
      ],
    }),

    page({
      title: "Extras",
      uiOrder: ["information", "rush", "rush_warning", "rush_reason", "*"],
      properties: {
        information: this.information,
        allergens: this.allergens,
        rush: this.rush,
      },
      dependencies: [
        dep.when(this.rush, [
          dep.eq("Rush", {
            properties: {
              rush_warning: this.rushWarning,
              rush_reason: this.rushReason,
            },
          }),
          dep.eq("Standard"),
        ]),
      ],
    }),
  ];

  // Minimal valid step set — a non-empty `steps` array is required by the schema.
  build(): Step[] {
    return [
      {
        id: "register-order",
        name: "Register Order",
        action: "debug:log",
        input: { orderedBy: this.requestedBy.ref },
      },
    ];
  }
}
