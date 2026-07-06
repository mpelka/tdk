// Unit test for `isArrayItemTitleId` — the pure predicate the custom
// TitleFieldTemplate uses to tell an ARRAY-ITEM title from a FIELD title by its RJSF
// id. The rendering itself is exercised in App.test.tsx (against payload-assembly);
// this pins the id-scheme rule the whole hierarchy fix hangs on.

import { describe, expect, test } from "bun:test";
import { isArrayItemTitleId } from "./formTemplates.tsx";

describe("isArrayItemTitleId", () => {
  test("an id whose last pre-`__title` segment is the item INDEX is an array-item title", () => {
    expect(isArrayItemTitleId("root_items_0__title")).toBe(true);
    expect(isArrayItemTitleId("root_items_12__title")).toBe(true);
    // Nested: an item inside a deeper array is still an item title.
    expect(isArrayItemTitleId("root_orders_2_lines_3__title")).toBe(true);
  });

  test("a FIELD title (segment is a property name, not an index) is not an array-item title", () => {
    // The array field's own title.
    expect(isArrayItemTitleId("root_items__title")).toBe(false);
    // A nested array FIELD title inside an item (segment `options`, not a number).
    expect(isArrayItemTitleId("root_items_0_options__title")).toBe(false);
    // The root object title, a scalar field title.
    expect(isArrayItemTitleId("root__title")).toBe(false);
    expect(isArrayItemTitleId("root_customerName__title")).toBe(false);
  });

  test("only the `__title` suffix counts (not a bare numeric segment elsewhere)", () => {
    // A digit segment that is NOT the last-before-`__title` must not match.
    expect(isArrayItemTitleId("root_items_0_sku__title")).toBe(false);
  });
});
