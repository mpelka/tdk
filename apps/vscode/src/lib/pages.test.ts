// Unit tests for `spec.parameters` normalization: single page object vs array of
// pages, empty/absent input, and that `toFormPages` lifts each page `title` out
// as the stepper label while splitting the rest for RJSF.

import { describe, expect, test } from "bun:test";
import { normalizePages, toFormPages } from "./pages.ts";

describe("normalizePages", () => {
  test("wraps a single page object in an array", () => {
    const page = { properties: { a: { type: "string" } }, required: ["a"] };
    expect(normalizePages(page)).toEqual([page]);
  });

  test("returns an array of pages unchanged", () => {
    const pages = [
      { title: "One", properties: {} },
      { title: "Two", properties: {} },
    ];
    expect(normalizePages(pages)).toEqual(pages);
  });

  test("returns an empty array for undefined / null", () => {
    expect(normalizePages(undefined)).toEqual([]);
    expect(normalizePages(null)).toEqual([]);
  });

  test("drops non-object entries from an array", () => {
    const pages = [{ properties: {} }, "nope", 42, null];
    expect(normalizePages(pages)).toEqual([{ properties: {} }]);
  });
});

describe("toFormPages", () => {
  test("lifts the page title as the step label and splits the rest", () => {
    const pages = toFormPages([
      {
        title: "Order Type",
        properties: { notes: { type: "string", "ui:widget": "textarea" } },
        required: ["notes"],
      },
    ]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBe("Order Type");
    // `title` is stripped from the schema (it's the step label, not a form heading).
    expect(pages[0]!.schema).toEqual({
      properties: { notes: { type: "string" } },
      required: ["notes"],
    });
    expect(pages[0]!.uiSchema).toEqual({ notes: { "ui:widget": "textarea" } });
  });

  test("leaves title undefined when the page has none (single-page templates)", () => {
    const pages = toFormPages({ properties: { a: { type: "string" } } });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toBeUndefined();
    expect(pages[0]!.schema).toEqual({ properties: { a: { type: "string" } } });
  });
});
