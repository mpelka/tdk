// Composition fragments — the generic `fragment(...)` reusable-page builder.
//
// `fragment(title, props)` yields a colocated PAGE that composes into a
// `defineTemplate` like any page, preserving its props' types so the composed
// fields are reachable as typed refs. Concrete org fragments built on top of it —
// e.g. a "Business Justification" page — live in the CONSUMER's shared code, not
// here. SYNTHETIC cake theme — no real-template tokens.

import { describe, expect, test } from "bun:test";
import { compile, defineTemplate, fragment, p, page, step } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

describe("fragment() — the generic reusable-page builder", () => {
  test("is a colocated page that preserves its props", () => {
    const topping = fragment("Topping", {
      sprinkles: p.boolean({ title: "Sprinkles", default: false }),
    });
    expect(topping.title).toBe("Topping");
    expect(Object.keys(topping.properties)).toEqual(["sprinkles"]);
  });

  test("composes into a defineTemplate as a page, reachable as a typed ref", () => {
    // A reusable single-field "Notes" page, built with fragment() and dropped last.
    const notesPage = fragment("Notes", {
      notes: p.string({ title: "Notes", uiWidget: "textarea", required: true }),
    });
    const cake = defineTemplate({
      id: "cake-order-frag",
      title: "Cake Order",
      type: "service",
      parameters: [
        page("Cake", { flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }) }),
        notesPage,
      ],
      // `f.notes` is inferred from the composed fragment (typed Ref<string>).
      steps: (f) => [step("order", "bakery:place", { input: { flavor: f.flavor, why: f.notes } })],
    });

    const { object } = compile(cake, nonprod);
    const pages = object.spec.parameters as Array<{
      title: string;
      required?: string[];
      properties: Record<string, unknown>;
    }>;
    expect(pages.map((pg) => pg.title)).toEqual(["Cake", "Notes"]);

    const last = pages.at(-1)!;
    expect(Object.keys(last.properties)).toEqual(["notes"]);
    expect(last.required).toEqual(["notes"]);
    expect(object.spec.steps[0]).toMatchObject({
      id: "order",
      input: { flavor: "${{ parameters.flavor }}", why: "${{ parameters.notes }}" },
    });
  });

  test("ONE fragment instance composes into MANY templates (same-name re-binding is idempotent)", () => {
    const notesPage = fragment("Notes", {
      notes: p.string({ title: "Notes", required: true }),
    });
    const make = (id: string) =>
      defineTemplate({
        id,
        title: id,
        type: "service",
        parameters: [notesPage],
        steps: (f) => [step("order", "bakery:place", { input: { why: f.notes } })],
      });
    // The shared param binds to the SAME key ("notes") in both templates —
    // allowed; only re-binding to a DIFFERENT name throws.
    const a = compile(make("cake-a"), nonprod);
    const b = compile(make("cake-b"), nonprod);
    for (const { object } of [a, b]) {
      expect(object.spec.steps[0]!.input!.why).toBe("${{ parameters.notes }}");
    }
  });
});
