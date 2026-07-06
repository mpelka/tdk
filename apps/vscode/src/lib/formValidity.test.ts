// Unit tests for the validity-gating seam — the pure check that decides whether the
// local simulate should run for the current form values.
//
// The conditional-required cases use schemas mirroring the EXACT shape core compiles
// showWhen / dep.when into (`dependencies.<controller>.oneOf[]` with `const`/`enum`/`not`
// match fragments — verified against `tdk compile examples/conditional-forms`), plus one
// test against the REAL compiled template to pin the no-false-positive direction on a
// genuine artifact.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { FormPage } from "../webview/protocol.ts";
import { formValidity } from "./formValidity.ts";
import { toFormPages } from "./pages.ts";

/** A one-page schema with the given required list + property titles. */
function page(required: string[], titles: Record<string, string> = {}): FormPage {
  const properties: Record<string, unknown> = {};
  for (const p of required) properties[p] = titles[p] ? { type: "string", title: titles[p] } : { type: "string" };
  return { schema: { type: "object", required, properties }, uiSchema: {} };
}

describe("formValidity", () => {
  test("a complete form is valid with no missing fields", () => {
    const pages = [page(["customerName", "priority"], { customerName: "Customer name", priority: "Priority" })];
    expect(formValidity(pages, { customerName: "Alice", priority: "high" })).toEqual({ valid: true, missing: [] });
  });

  test("missing required fields are listed by their schema TITLE, in form order", () => {
    const pages = [page(["customerName", "priority"], { customerName: "Customer name", priority: "Priority" })];
    expect(formValidity(pages, {})).toEqual({
      valid: false,
      missing: ["Customer name", "Priority"],
    });
  });

  test("falls back to the property name when a field has no title", () => {
    const pages = [page(["flavor"])];
    expect(formValidity(pages, {}).missing).toEqual(["flavor"]);
  });

  test("empties count as absent: undefined, null, empty string, empty array all gate", () => {
    const pages = [page(["a", "b", "c", "d"])];
    expect(formValidity(pages, { a: undefined, b: null, c: "", d: [] }).valid).toBe(false);
    expect(formValidity(pages, { a: undefined, b: null, c: "", d: [] }).missing).toEqual(["a", "b", "c", "d"]);
  });

  test("non-empty values (incl. 0, false, {}) count as present", () => {
    const pages = [page(["a", "b", "c"])];
    expect(formValidity(pages, { a: 0, b: false, c: {} })).toEqual({ valid: true, missing: [] });
  });

  test("PER-PAGE required lists are all honored (the wizard validates page by page)", () => {
    const pages = [
      page(["customerName"], { customerName: "Customer name" }),
      page(["priority"], { priority: "Priority" }),
    ];
    // Page 1 satisfied, page 2 missing.
    expect(formValidity(pages, { customerName: "Alice" })).toEqual({ valid: false, missing: ["Priority"] });
  });

  test("a field required by two pages is reported once (deduped by label)", () => {
    const pages = [page(["shared"], { shared: "Shared field" }), page(["shared"], { shared: "Shared field" })];
    expect(formValidity(pages, {}).missing).toEqual(["Shared field"]);
  });

  test("a page with no required list contributes nothing", () => {
    const pages: FormPage[] = [{ schema: { type: "object", properties: {} }, uiSchema: {} }];
    expect(formValidity(pages, {})).toEqual({ valid: true, missing: [] });
  });
});

describe("formValidity — conditional requireds (the compiled dependencies tree)", () => {
  // The EXACT shape core compiles a showWhen chain into (mirrors the compiled
  // conditional-forms page 1, with a branch-level `required` added): a wedding reveals
  // `tiers` (required) + `topper`, and — nested inside the wedding branch — checking
  // `topper` reveals a required `topperText`.
  const weddingPage: FormPage = {
    schema: {
      type: "object",
      properties: { orderType: { type: "string", title: "Order type", enum: ["standard", "custom", "wedding"] } },
      required: ["orderType"],
      dependencies: {
        orderType: {
          oneOf: [
            { properties: { orderType: { const: "standard" } } },
            { properties: { orderType: { const: "custom" } } },
            {
              properties: {
                orderType: { const: "wedding" },
                tiers: { type: "number", title: "Number of tiers" },
                topper: { type: "boolean", title: "Add a cake topper?" },
              },
              required: ["tiers"],
              dependencies: {
                topper: {
                  oneOf: [
                    {
                      properties: { topper: { const: true }, topperText: { type: "string", title: "Topper text" } },
                      required: ["topperText"],
                    },
                    { properties: { topper: { const: false } } },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    uiSchema: {},
  };

  test("the ACTIVE branch's required field is missing → invalid, listed by its BRANCH title", () => {
    const result = formValidity([weddingPage], { orderType: "wedding" });
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["Number of tiers"]);
  });

  test("an INACTIVE branch's required is never reported (no false positive)", () => {
    // A standard order activates the standard branch — the wedding branch's `tiers`
    // must NOT be reported missing.
    expect(formValidity([weddingPage], { orderType: "standard" })).toEqual({ valid: true, missing: [] });
  });

  test("an UNSET controller activates no branch — only the top-level required reports", () => {
    const result = formValidity([weddingPage], {});
    expect(result.missing).toEqual(["Order type"]);
  });

  test("NESTED dependencies: the inner controller's active branch gates too", () => {
    // Wedding + tiers satisfied, topper checked → the nested branch requires topperText.
    const result = formValidity([weddingPage], { orderType: "wedding", tiers: 3, topper: true });
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["Topper text"]);
    // …and topper unchecked activates the other nested branch — nothing required.
    expect(formValidity([weddingPage], { orderType: "wedding", tiers: 3, topper: false })).toEqual({
      valid: true,
      missing: [],
    });
  });

  test("an `enum` match fragment activates its branch (dep.oneOf form)", () => {
    const pageEnum: FormPage = {
      schema: {
        type: "object",
        properties: { size: { type: "string", title: "Size" } },
        dependencies: {
          size: {
            oneOf: [
              {
                properties: { size: { enum: ["large", "xl"] }, boxCount: { type: "number", title: "Box count" } },
                required: ["boxCount"],
              },
              { properties: { size: { enum: ["small"] } } },
            ],
          },
        },
      },
      uiSchema: {},
    };
    expect(formValidity([pageEnum], { size: "xl" }).missing).toEqual(["Box count"]);
    expect(formValidity([pageEnum], { size: "small" })).toEqual({ valid: true, missing: [] });
  });

  test("a `not`+`const` match fragment activates only when the value is present and differs", () => {
    const pageNot: FormPage = {
      schema: {
        type: "object",
        properties: { flavor: { type: "string", title: "Flavor" } },
        dependencies: {
          flavor: {
            oneOf: [
              { properties: { flavor: { const: "vanilla" } } },
              {
                properties: { flavor: { not: { const: "vanilla" } }, warning: { type: "string", title: "Warning" } },
                required: ["warning"],
              },
            ],
          },
        },
      },
      uiSchema: {},
    };
    expect(formValidity([pageNot], { flavor: "chocolate" }).missing).toEqual(["Warning"]);
    expect(formValidity([pageNot], { flavor: "vanilla" })).toEqual({ valid: true, missing: [] });
    // Unset controller: NO branch matches (never a false positive from `not`).
    expect(formValidity([pageNot], {})).toEqual({ valid: true, missing: [] });
  });

  test("an unrecognized match fragment never activates a branch (no false positive)", () => {
    const pageOdd: FormPage = {
      schema: {
        type: "object",
        properties: { qty: { type: "number", title: "Quantity" } },
        dependencies: {
          qty: {
            oneOf: [
              { properties: { qty: { minimum: 10 } }, required: ["bulkDiscount"] },
              { properties: { qty: { maximum: 9 } } },
            ],
          },
        },
      },
      uiSchema: {},
    };
    // We can't positively evaluate `minimum` — merge nothing rather than guess.
    expect(formValidity([pageOdd], { qty: 50 })).toEqual({ valid: true, missing: [] });
  });

  test("the plain PROPERTY-dependency form (rawDependencies) activates when the key is present", () => {
    const pageProp: FormPage = {
      schema: {
        type: "object",
        properties: {
          creditCard: { type: "string", title: "Credit card" },
          billingAddress: { type: "string", title: "Billing address" },
        },
        dependencies: { creditCard: ["billingAddress"] },
      },
      uiSchema: {},
    };
    expect(formValidity([pageProp], { creditCard: "4111" }).missing).toEqual(["Billing address"]);
    expect(formValidity([pageProp], {})).toEqual({ valid: true, missing: [] });
  });

  test("the SCHEMA-dependency form without oneOf (`{ required }`) activates when the key is present", () => {
    const pageSchemaDep: FormPage = {
      schema: {
        type: "object",
        properties: {
          giftWrap: { type: "boolean", title: "Gift wrap" },
          giftNote: { type: "string", title: "Gift note" },
        },
        dependencies: { giftWrap: { required: ["giftNote"] } },
      },
      uiSchema: {},
    };
    expect(formValidity([pageSchemaDep], { giftWrap: true }).missing).toEqual(["Gift note"]);
    expect(formValidity([pageSchemaDep], {})).toEqual({ valid: true, missing: [] });
  });
});

describe("formValidity — against the REAL compiled conditional-forms template", () => {
  // Compile the gold-standard branching example through the real CLI (the same pattern
  // examples.test.ts uses) and run the gate on its actual pages — pinning the
  // no-false-positive direction on a genuine compiled artifact: none of its conditional
  // fields are required, so no branch may ever report one missing.
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
  const cli = join(repoRoot, "apps", "cli", "src", "cli.ts");
  const template = join(repoRoot, "examples", "conditional-forms", "template.ts");
  const compiled = spawnSync("bun", ["run", cli, "compile", template], { encoding: "utf8" });
  if (compiled.status !== 0) throw new Error(`compile conditional-forms failed:\n${compiled.stderr}`);
  const parsed = parseYaml(compiled.stdout) as { spec?: { parameters?: unknown } };
  const pages = toFormPages(parsed.spec?.parameters);

  test("an empty form misses only the top-level requireds — never a conditional field", () => {
    const result = formValidity(pages, {});
    expect(result.valid).toBe(false);
    // The template's real requireds (by title), and none of the revealed fields.
    expect(result.missing).toContain("Order type");
    expect(result.missing).toContain("Contact email");
    for (const conditional of ["Number of tiers", "Add a cake topper?", "Topper text", "Ribbon colour"]) {
      expect(result.missing).not.toContain(conditional);
    }
  });

  test("a wedding with the requireds filled is valid (its revealed fields are optional in this template)", () => {
    expect(formValidity(pages, { orderType: "wedding", contactEmail: "alice@bakery.example" })).toEqual({
      valid: true,
      missing: [],
    });
  });
});
