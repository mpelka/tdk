// Behaviour + type-inference coverage for the functional ("Option C") API.
//
// `cakeOrderFn` (authored with `defineTemplate` + colocated `page(title, props)`)
// is the canonical functional fixture: this file pins the entity it compiles to
// (colocated pages, refs threaded into steps/output) and its execute output, plus
// the flat-parameters form. It also carries the TYPE-INFERENCE proof: that
// `steps`/`output`'s `f` is a flat, typed `{ name: Ref<T> }` map (wrong names +
// wrong types are `@ts-expect-error`s, checked by `tsc`).

import { describe, expect, test } from "bun:test";
import type { FieldRefs, InputValue, Ref } from "../index.ts";
import { compile, defineTemplate, execute, p, page, step } from "../index.ts";
import { cakeOrderFn } from "./cake-order-fn.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

/**
 * The FLAT form: `defineTemplate` with `parameters` as a bare props object (not an
 * array of pages) → compiles to a single `{ properties, required }` object.
 */
const cakeOrderFlat = defineTemplate({
  id: "cake-order-flat",
  title: "Cake Order (flat)",
  description: "Order a cake from a partner bakery.",
  type: "service",
  parameters: {
    flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
    notes: p.string({ title: "Notes", uiWidget: "textarea" }),
  },
  steps: (f) => [
    step("order", "bakery:place", {
      name: "Place the order",
      input: { flavor: f.flavor, notes: f.notes },
    }),
  ],
  output: (f) => ({ flavour: f.flavor }),
});

describe("defineTemplate — colocated pages", () => {
  test("emits the expected entity shape (2 colocated pages, refs in steps/output)", () => {
    const { object } = compile(cakeOrderFn, nonprod);
    expect(object.metadata.name).toBe("cake-order");
    const pages = object.spec.parameters as Array<{ title: string; properties: Record<string, unknown> }>;
    expect(pages.map((p) => p.title)).toEqual(["Cake", "Extras"]);
    expect(pages[0]!.properties.flavor).toMatchObject({
      type: "string",
      enum: ["Vanilla", "Chocolate"],
    });
    expect(object.spec.steps[0]).toMatchObject({
      id: "order",
      action: "bakery:place",
      input: { flavor: "${{ parameters.flavor }}", size: "${{ parameters.size }}" },
    });
    expect(object.spec.output).toEqual({
      flavour: "${{ parameters.flavor }}",
      size: "${{ parameters.size }}",
    });
  });
});

describe("defineTemplate — execute", () => {
  test("renders the param-driven run output + step inputs", async () => {
    const fixture = {
      // `as const` keeps the enum literals narrow — execute() now types the
      // fixture's parameters against the template's declared params.
      parameters: { flavor: "Chocolate", size: "Large", notes: "Extra sprinkles" } as const,
      steps: { order: { output: { ok: true, ref: "order-123" } } },
    };
    const fnRun = await execute(cakeOrderFn, fixture);
    expect(fnRun.output).toEqual({ flavour: "Chocolate", size: "Large" });
    expect(fnRun.steps.order!.input).toEqual({
      flavor: "Chocolate",
      size: "Large",
      notes: "Extra sprinkles",
    });
  });
});

describe("defineTemplate — duplicate parameter names across pages", () => {
  test("throws at definition time, naming the duplicate", () => {
    expect(() =>
      defineTemplate({
        id: "cake-order-dup",
        title: "Cake Order (dup)",
        type: "service",
        parameters: [
          page("Cake", { flavor: p.enum(["Vanilla", "Chocolate"]) }),
          // `flavor` again on a second page — the flat field map cannot hold both.
          page("Extras", { flavor: p.string() }),
        ],
        steps: () => [step("order", "bakery:place")],
      }),
    ).toThrow(/duplicate parameter name "flavor" across pages/);
  });
});

describe("defineTemplate — flat parameters (bare props)", () => {
  test("`spec.parameters` is ONE JSON-Schema object, not an array of pages", () => {
    const { object } = compile(cakeOrderFlat, nonprod);
    expect(Array.isArray(object.spec.parameters)).toBe(false);
    expect(object.spec.parameters).toEqual({
      properties: {
        flavor: { type: "string", title: "Flavour", enum: ["Vanilla", "Chocolate"] },
        notes: { type: "string", title: "Notes", "ui:widget": "textarea" },
      },
      required: ["flavor"],
    });
    expect(object.spec.steps[0]).toMatchObject({
      id: "order",
      action: "bakery:place",
      input: { flavor: "${{ parameters.flavor }}", notes: "${{ parameters.notes }}" },
    });
    expect(object.spec.output).toEqual({ flavour: "${{ parameters.flavor }}" });
  });
});

// ---------------------------------------------------------------------------
// TYPE-INFERENCE PROOF — never executed; verified by `tsc --noEmit` (typecheck).
//
// Reproduces `cakeOrderFn`'s `parameters` so we can name the inferred `f` type
// (`FieldRefs<typeof proofPages>`) and assert it: each field is its param's
// `Ref<T>`, usable as an `InputValue`; a wrong name and a wrong type are errors.
// ---------------------------------------------------------------------------

const proofPages = [
  page("Cake", {
    flavor: p.enum({ title: "Flavour", enum: ["Vanilla", "Chocolate"], required: true }),
    size: p.enum({ title: "Size", enum: ["Small", "Large"], required: true }),
  }),
  page("Extras", {
    notes: p.string({ title: "Notes", uiWidget: "textarea" }),
  }),
];

type ProofRefs = FieldRefs<typeof proofPages>;

function _fieldRefsTypeProof(f: ProofRefs): void {
  // (a) f.flavor IS the param's typed ref — Ref<"Vanilla" | "Chocolate"> ...
  const flavorRef: Ref<"Vanilla" | "Chocolate"> = f.flavor;
  void flavorRef;
  // ... and usable anywhere an InputValue is (it's a RawRef).
  const asInput: InputValue = f.flavor;
  void asInput;
  // (b) the inference is per-param: notes is Ref<string>.
  const notesRef: Ref<string> = f.notes;
  void notesRef;
  // @ts-expect-error — `flavr` is not a field (names are inferred from the props)
  void f.flavr;
  // @ts-expect-error — flavor is Ref<"Vanilla" | "Chocolate">, not Ref<number>
  const wrongType: Ref<number> = f.flavor;
  void wrongType;
}
void _fieldRefsTypeProof;

// ---------------------------------------------------------------------------
// FLAT-FORM TYPE-INFERENCE PROOF — `parameters` as a bare props object infers an
// `f` keyed by the props' OWN names/types; a wrong name is an error.
// ---------------------------------------------------------------------------

const flatProofProps = {
  flavor: p.enum(["Vanilla", "Chocolate"], { title: "Flavour", required: true }),
  notes: p.string({ title: "Notes", uiWidget: "textarea" }),
};

type FlatProofRefs = FieldRefs<typeof flatProofProps>;

function _flatFieldRefsTypeProof(f: FlatProofRefs): void {
  // f.flavor IS the param's typed ref, and usable anywhere an InputValue is.
  const flavorRef: Ref<"Vanilla" | "Chocolate"> = f.flavor;
  void flavorRef;
  const asInput: InputValue = f.notes;
  void asInput;
  // @ts-expect-error — `flavr` is not a field (the flat form infers names from the props' keys)
  void f.flavr;
}
void _flatFieldRefsTypeProof;
