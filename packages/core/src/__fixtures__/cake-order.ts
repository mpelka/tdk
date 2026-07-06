// A synthetic, block-bodied `jsonata(...)` benchmark for the transpiler's STATEMENT
// LAYER. Invented domain (a bakery "custom cake order" pricing/summary builder)
// — it deliberately reproduces no real-world template, only the procedural
// SHAPE the statement layer must handle:
//
//   - `const` / `let` bindings,
//   - reassignment of a `let`,
//   - `assert(...)` precondition guards (incl. conditional ones),
//   - `.concat(...)` → `$append`,
//   - array-literal `.includes(...)` → membership `in`,
//   - nested ternaries (incl. a "set ? … : ''" optional segment),
//   - a returned object.
//
// The colocated `.test.ts` differential-tests this expression two ways: the JS
// oracle vs the compiled JSONata, AND the compiled JSONata vs a reference JSONata
// string — over fixtures that cover every branch, including the `assert` throws.

import { assert, jsonata } from "../index.ts";

/** The JSONata `data` context: every field is a string, `""` when not set. */
export type CakeOrderCtx = {
  size: string; // "6 inch" | "8 inch" | "10 inch" | "Sheet" | other
  flavour: string;
  customerName: string;
  membership: string; // "" | "Member"
  occasion: string; // "" | "Birthday" | ...
  giftBox: string; // "Yes" | "No"
  giftMessage: string;
  rushOrder: string; // "Yes" | "No"
  rushReason: string;
  decorations: string;
};

/** One priced line on the order. */
type LineItem = { label: string; amount: number };

export const cakeOrderSummary = jsonata<CakeOrderCtx>((c) => {
  assert(c.customerName !== "", "A customer name is required.");
  assert(c.rushOrder !== "Yes" || c.rushReason !== "", "A reason is required for a rush order.");
  assert(c.giftBox !== "Yes" || c.giftMessage !== "", "A gift message is required when a gift box is selected.");

  // Nested ternary with an array-literal `.includes` membership test in the
  // middle. Every branch is exercised by a fixture so the file stays 100% line.
  const basePrice =
    c.size === "6 inch" ? 20 : ["8 inch", "10 inch"].includes(c.size) ? 35 : c.size === "Sheet" ? 60 : 0;

  const summary =
    "Customer: " +
    c.customerName +
    "\n" +
    "Size: " +
    c.size +
    "\n" +
    "Flavour: " +
    c.flavour +
    "\n" +
    // biome-ignore lint/style/useTemplate: this fixture is transpiler INPUT — the `+` string concatenation is deliberately what `jsonata(...)` transpiles here
    (c.occasion ? "Occasion: " + c.occasion + "\n" : "") +
    "Decorations: " +
    c.decorations;

  let lineItems: LineItem[] =
    c.membership === "Member"
      ? [
          { label: "Base", amount: basePrice },
          { label: "Member discount", amount: -5 },
        ]
      : [{ label: "Base", amount: basePrice }];

  lineItems = lineItems.concat([{ label: "Delivery", amount: 4 }]);

  lineItems = c.rushOrder === "Yes" ? lineItems.concat([{ label: "Rush surcharge", amount: 8 }]) : lineItems;

  return {
    summary: summary,
    basePrice: basePrice,
    lineItems: lineItems,
  };
});
