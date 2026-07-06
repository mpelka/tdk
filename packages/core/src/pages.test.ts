import { beforeEach, describe, expect, test } from "bun:test";
import { depTree } from "./__fixtures__/entity-access.ts";
import type { PageObject } from "./index.ts";
import { _resetEnvRegistry, all, compile, dep, p, page, Template } from "./index.ts";
import { splitErrorMessage } from "./params.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

beforeEach(() => {
  _resetEnvRegistry();
});

/** Compile a template and return its `spec.parameters` as a page array. */
function pagesOf(tpl: Template): PageObject[] {
  return compile(tpl, nonprod).object.spec.parameters as PageObject[];
}

describe("property features", () => {
  test("enum/enumNames/default/ui:* keys are emitted in the right places", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: {
            choice: p.string({
              title: "Choice",
              description: "pick",
              enum: ["a", "b"],
              enumNames: ["A", "B"],
              default: "a",
              uiWidget: "radio",
              uiPlaceholder: "Pick one",
              uiOptions: { rows: 3 },
            }),
          },
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.properties.choice).toEqual({
      type: "string",
      title: "Choice",
      description: "pick",
      default: "a",
      enum: ["a", "b"],
      enumNames: ["A", "B"],
      "ui:widget": "radio",
      "ui:placeholder": "Pick one",
      "ui:options": { rows: 3 },
    });
  });
});

describe("custom field-type helpers", () => {
  test("p.customField (BakerPicker) emits ui:field + prefillCurrentUser", () => {
    expect(
      p
        .customField({
          type: "string",
          title: "Request for",
          uiField: "BakerPicker",
          uiOptions: { prefillCurrentUser: true },
        })
        .toSchema(),
    ).toEqual({
      type: "string",
      title: "Request for",
      "ui:field": "BakerPicker",
      "ui:options": { prefillCurrentUser: true },
    });
  });

  test("p.customField (BakerPicker) without ui:options omits it", () => {
    expect(p.customField({ type: "string", uiField: "BakerPicker" }).toSchema()).toEqual({
      type: "string",
      "ui:field": "BakerPicker",
    });
  });

  test("p.customField (FlavorEntityPicker) emits ui:field + catalogFilter.kind", () => {
    expect(
      p
        .customField({
          type: "string",
          uiField: "FlavorEntityPicker",
          uiOptions: { catalogFilter: { kind: "CakeCatalog" } },
        })
        .toSchema(),
    ).toEqual({
      type: "string",
      "ui:field": "FlavorEntityPicker",
      "ui:options": { catalogFilter: { kind: "CakeCatalog" } },
    });
  });

  test("p.customField (OrderDetailsDisplay) emits an object with all details under ui:options", () => {
    expect(
      p
        .customField({
          type: "object",
          uiField: "OrderDetailsDisplay",
          uiOptions: {
            title: "Bakery Details",
            sourceField: "cake_code",
            kind: "CakeCatalog",
            displayFields: ["cakeName"],
          },
        })
        .toSchema(),
    ).toEqual({
      type: "object",
      "ui:field": "OrderDetailsDisplay",
      "ui:options": {
        title: "Bakery Details",
        sourceField: "cake_code",
        kind: "CakeCatalog",
        displayFields: ["cakeName"],
      },
    });
  });

  test("p.customField (NoteDisplay) emits ui:field + template", () => {
    expect(
      p
        .customField({ type: "string", title: "Note", uiField: "NoteDisplay", uiOptions: { template: "hello" } })
        .toSchema(),
    ).toEqual({
      type: "string",
      title: "Note",
      "ui:field": "NoteDisplay",
      "ui:options": { template: "hello" },
    });
  });

  test("p.customField emits ui:field + ui:options verbatim (CakePickerWithDefault)", () => {
    expect(
      p
        .customField({
          title: "Cake Code",
          required: true,
          uiField: "CakePickerWithDefault",
          uiOptions: {
            placeholder: "Select cake...",
            path: "bakery-catalog/entities?filter=kind=CakeCatalog",
            arraySelector: "",
            valueSelector: "metadata.name",
            labelSelector: "metadata.name",
          },
        })
        .toSchema(),
    ).toEqual({
      type: "string",
      title: "Cake Code",
      "ui:field": "CakePickerWithDefault",
      "ui:options": {
        placeholder: "Select cake...",
        path: "bakery-catalog/entities?filter=kind=CakeCatalog",
        arraySelector: "",
        valueSelector: "metadata.name",
        labelSelector: "metadata.name",
      },
    });
  });

  test("p.customField honours a non-string type override", () => {
    expect(p.customField({ type: "object", uiField: "MyWidget" }).toSchema()).toEqual({
      type: "object",
      "ui:field": "MyWidget",
    });
  });
});

describe("p.string minLength / maxLength", () => {
  test("both bounds are emitted in the schema", () => {
    expect(p.string({ minLength: 1, maxLength: 75, uiWidget: "textarea" }).toSchema()).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 75,
      "ui:widget": "textarea",
    });
  });
});

describe("dep.eq / dep.not accept boolean & number consts", () => {
  test("dep.eq(true) → const: true; dep.not(0) → not const 0", () => {
    const flag = p.boolean();
    const n = p.number();
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { flag, n },
          dependencies: [
            dep.when(flag, [dep.eq(true, { properties: { shown: p.string() } }), dep.eq(false)]),
            dep.when(n, [dep.not(0)]),
          ],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    const deps = depTree(pg!);
    expect(deps.flag.oneOf[0]!.properties.flag).toEqual({ const: true });
    expect(deps.flag.oneOf[1]!.properties.flag).toEqual({ const: false });
    expect(deps.n.oneOf[0]!.properties.n).toEqual({ not: { const: 0 } });
  });
});

describe("pages", () => {
  test("required is derived from property required flags in declaration order", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: {
            a: p.string({ required: true }),
            b: p.string(),
            c: p.string({ required: true }),
          },
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.required).toEqual(["a", "c"]);
  });

  test("an explicit required list overrides derivation; ui:order passes through", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          required: ["b"],
          uiOrder: ["b", "a", "*"],
          properties: { a: p.string({ required: true }), b: p.string() },
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.required).toEqual(["b"]);
    expect(pg!["ui:order"]).toEqual(["b", "a", "*"]);
  });

  test("a page with no required entries omits the required key", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [page({ title: "P", properties: { a: p.string() } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.required).toBeUndefined();
    expect(pg!.dependencies).toBeUndefined();
  });

  test("colocated page(title, props, { uiOrder }) emits ui:order like the object form", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [page("P", { a: p.string({ required: true }), b: p.string() }, { uiOrder: ["b", "a", "*"] })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    // uiOrder flows to ui:order EXACTLY as the object form does (via buildPage)…
    expect(pg!["ui:order"]).toEqual(["b", "a", "*"]);
    // …and the colocated props still drive required derivation unchanged.
    expect(pg!.required).toEqual(["a"]);
  });

  test("flat `params` still compile to a single schema object (backward-compat)", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      params = { a: p.string({ required: true }) };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new T(), nonprod);
    expect(Array.isArray(object.spec.parameters)).toBe(false);
    expect((object.spec.parameters as { properties: unknown }).properties).toEqual({ a: { type: "string" } });
  });
});

describe("dependency-source collisions (one controller, one source)", () => {
  test("dep.when + showWhen on the same controller throws, naming both sources", () => {
    const mode = p.string({ enum: ["a", "b"] });
    class T extends Template {
      id = "collide";
      title = "Collide";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { mode, sw: p.string({ showWhen: { mode: "a" } }) },
          dependencies: [dep.when(mode, [dep.eq("b", { properties: { hand: p.string() } })])],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(
      /page "P": controller "mode" has dependencies from both dep\.when\(\.\.\.\) and showWhen/,
    );
  });

  test("rawDependencies + dep.when on the same controller throws", () => {
    const mode = p.string({ enum: ["a", "b"] });
    class T extends Template {
      id = "collide-raw";
      title = "Collide Raw";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { mode },
          dependencies: [dep.when(mode, [dep.eq("a"), dep.eq("b")])],
          rawDependencies: { mode: { oneOf: [] } },
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/controller "mode" has dependencies from both dep\.when/);
  });

  test("different controllers from different sources still coexist", () => {
    const mode = p.string({ enum: ["a", "b"] });
    const flag = p.boolean();
    class T extends Template {
      id = "coexist";
      title = "Coexist";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { mode, flag, note: p.string({ showWhen: { flag: true } }) },
          dependencies: [dep.when(mode, [dep.eq("a"), dep.eq("b")])],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(Object.keys(pg!.dependencies as object).sort()).toEqual(["flag", "mode"]);
  });
});

describe("non-Param page properties", () => {
  test("a raw schema object in page properties throws, pointing at p.*", () => {
    class T extends Template {
      id = "raw-page-prop";
      title = "Raw Page Prop";
      type = "service";
      // Deliberately bypassing the ParamMap type to pin the runtime guard.
      pages = [page({ title: "P", properties: { flavor: { type: "string" } as any } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/property "flavor" is not a Param — wrap it in a p\.\* helper/);
  });
});

describe("param binding + schema isolation", () => {
  test("re-binding one Param instance under two names throws", () => {
    const shared = p.string();
    class T extends Template {
      id = "rebind";
      title = "Rebind";
      type = "service";
      params = { first: shared, second: shared };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/already bound to "first" cannot be re-bound to "second"/);
  });

  test("re-binding to the SAME name stays idempotent (compile twice)", () => {
    class T extends Template {
      id = "idem";
      title = "Idem";
      type = "service";
      params = { name: p.string() };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const tpl = new T();
    expect(() => {
      compile(tpl, nonprod);
      compile(tpl, nonprod);
    }).not.toThrow();
  });

  test("toSchema clones deeply — a shared ui:options object never aliases in YAML", () => {
    const sharedOpts = { rows: 3 };
    class T extends Template {
      id = "clone";
      title = "Clone";
      type = "service";
      params = {
        one: p.string({ uiOptions: sharedOpts }),
        two: p.string({ uiOptions: sharedOpts }),
      };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object, yaml } = compile(new T(), nonprod);
    const props = (object.spec.parameters as { properties: Record<string, Record<string, unknown>> }).properties;
    // Distinct objects per schema (no cross-artifact mutation channel)...
    expect(props.one!["ui:options"]).not.toBe(props.two!["ui:options"]);
    expect(props.one!["ui:options"]).not.toBe(sharedOpts);
    // ...so the YAML carries no anchor/alias pair.
    expect(yaml).not.toMatch(/&a\d|\*a\d/);
  });
});

describe("enumNames validation", () => {
  test("p.enum with a mismatched enumNames length throws", () => {
    expect(() => p.enum({ enum: ["a", "b", "c"], enumNames: ["Only", "Two"] })).toThrow(
      /enumNames has 2 label\(s\) for 3 enum value\(s\)/,
    );
  });

  test("p.string with enumNames but no enum throws", () => {
    expect(() => p.string({ enumNames: ["Stray"] })).toThrow(/enumNames requires enum/);
  });

  test("matching lengths still emit value/label pairs", () => {
    expect(p.enum(["L", "H"], { enumNames: ["Low", "High"] }).toSchema()).toEqual({
      type: "string",
      enum: ["L", "H"],
      enumNames: ["Low", "High"],
    });
  });
});

describe("p.enum extra options", () => {
  test("array form merges extra options (title/required)", () => {
    const param = p.enum(["a", "b"], { title: "Pick", required: true });
    expect(param.toSchema()).toEqual({ type: "string", title: "Pick", enum: ["a", "b"] });
    expect(param.required).toBe(true);
  });

  test("object form + extra merges at runtime (JS callers), options object winning", () => {
    // The overloads make this a TYPE error (see the type proof below); a JS
    // caller who does it anyway must not silently lose `extra`.
    const param = (p.enum as any)({ enum: ["a", "b"], title: "Wins" }, { title: "Loses", required: true });
    expect(param.toSchema()).toEqual({ type: "string", title: "Wins", enum: ["a", "b"] });
    expect(param.required).toBe(true);
  });
});

// TYPE PROOF — never executed; verified by `tsc --noEmit` (typecheck).
function _enumOverloadTypeProof(): void {
  // @ts-expect-error — `extra` belongs to the ARRAY form; pass ONE options object instead
  p.enum({ enum: ["a", "b"] }, { title: "nope" });
}
void _enumOverloadTypeProof;

describe("conditional dependencies", () => {
  test("dep.eq builds const branches with derived required", () => {
    const control = p.string();
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { flag: control },
          dependencies: [
            dep.when(control, [dep.eq("Yes", { properties: { extra: p.string({ required: true }) } }), dep.eq("No")]),
          ],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.dependencies).toEqual({
      flag: {
        oneOf: [
          {
            properties: {
              flag: { const: "Yes" },
              extra: { type: "string" },
            },
            required: ["extra"],
          },
          { properties: { flag: { const: "No" } } },
        ],
      },
    });
  });

  test("dep.oneOf (enum match) and dep.not (negative match)", () => {
    const control = p.string();
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { x: control },
          dependencies: [dep.when(control, [dep.oneOf(["a", "b"]), dep.not("a")])],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    expect(pg!.dependencies).toEqual({
      x: {
        oneOf: [{ properties: { x: { enum: ["a", "b"] } } }, { properties: { x: { not: { const: "a" } } } }],
      },
    });
  });

  test("nested dependencies (branch carrying its own dependencies)", () => {
    const style = p.string();
    const topper = p.string({ enum: ["Custom", "Standard"] });
    const specify = p.string();
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { style },
          dependencies: [
            dep.when(style, [
              dep.eq("Layered", {
                properties: { topper },
                dependencies: [
                  dep.when(topper, [dep.eq("Custom", { properties: { topper_text: specify } }), dep.not("Custom")]),
                ],
              }),
            ]),
          ],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    const branch = depTree(pg!).style.oneOf[0]!;
    expect(branch.properties.style).toEqual({ const: "Layered" });
    expect(branch.dependencies!.topper.oneOf).toEqual([
      {
        properties: {
          topper: { const: "Custom" },
          topper_text: { type: "string" },
        },
      },
      { properties: { topper: { not: { const: "Custom" } } } },
    ]);
  });

  test("conditional-field refs are bound (usable in steps)", () => {
    const control = p.string();
    const extra = p.string();
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { flag: control },
          dependencies: [dep.when(control, [dep.eq("Yes", { properties: { extra_field: extra } })])],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log", input: { v: extra.ref } }];
      }
    }
    const { object } = compile(new T(), nonprod);
    expect(object.spec.steps[0]!.input!.v).toBe("${{ parameters.extra_field }}");
  });
});

// ---------------------------------------------------------------------------
// errorMessage (#59) — human validation messages emitted as the ajv-errors keyword.
//
// The split rule (see splitErrorMessage):
//   - a STRING covers every keyword failure of the field AND its required failure;
//   - an OBJECT is emitted on the field with `required` peeled off to the parent;
//   - a `required` message applies only when the field is `required: true`.
// The FIELD part lands in the property schema; the REQUIRED part lifts to the
// object schema where required fails — the page, or the branch a conditional
// field is revealed in.
// ---------------------------------------------------------------------------

/** A one-page template over `props`, for the errorMessage assertions. */
function onePage(props: Record<string, ReturnType<typeof p.string>>, required?: string[]): PageObject {
  class T extends Template {
    id = "t";
    title = "T";
    type = "service";
    pages = [required ? page({ title: "P", properties: props, required }) : page({ title: "P", properties: props })];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }
  return pagesOf(new T())[0]!;
}

describe("splitErrorMessage (unit)", () => {
  test("a string covers the field AND (when required) the required failure", () => {
    expect(splitErrorMessage("msg", true)).toEqual({ property: "msg", required: "msg" });
  });
  test("a string on an OPTIONAL field emits no required part", () => {
    expect(splitErrorMessage("msg", false)).toEqual({ property: "msg", required: undefined });
  });
  test("an object peels `required` off to the parent, keeping the rest on the field", () => {
    expect(splitErrorMessage({ pattern: "pat", required: "req" }, true)).toEqual({
      property: { pattern: "pat" },
      required: "req",
    });
  });
  test("an object with ONLY `required` yields no field-level part", () => {
    expect(splitErrorMessage({ required: "req" }, true)).toEqual({ required: "req" });
  });
  test("an object's `required` is dropped when the field is not required", () => {
    expect(splitErrorMessage({ pattern: "pat", required: "req" }, false)).toEqual({ property: { pattern: "pat" } });
  });
  test("undefined is a no-op both halves absent", () => {
    expect(splitErrorMessage(undefined, true)).toEqual({});
  });
});

describe("errorMessage — field-level emission", () => {
  test("the string form emits `errorMessage` last on the property schema", () => {
    const schema = p.string({ title: "Slot", pattern: "^(am|pm)$", errorMessage: "Choose am or pm." }).toSchema();
    expect(schema).toEqual({
      type: "string",
      title: "Slot",
      pattern: "^(am|pm)$",
      errorMessage: "Choose am or pm.",
    });
    // errorMessage is the trailing key (reads well after the keywords it relabels).
    expect(Object.keys(schema).at(-1)).toBe("errorMessage");
  });

  test("the object form emits its keyword messages, with `required` peeled off the field", () => {
    const schema = p
      .string({ pattern: "^[A-Z]+$", errorMessage: { pattern: "Uppercase only.", required: "Code is required." } })
      .toSchema();
    // `required` does NOT stay on the field — it lifts to the parent.
    expect(schema.errorMessage).toEqual({ pattern: "Uppercase only." });
  });

  test("a param with no errorMessage emits a byte-identical schema (no key added)", () => {
    expect(p.string({ title: "Plain", pattern: "^x$" }).toSchema()).toEqual({
      type: "string",
      title: "Plain",
      pattern: "^x$",
    });
  });
});

describe("errorMessage — parent-level required assembly", () => {
  test("the string form on a required field lifts its message to the page's errorMessage.required", () => {
    const pg = onePage({
      email: p.string({ title: "Email", format: "email", required: true, errorMessage: "Enter a valid email." }),
      notes: p.string({ title: "Notes" }),
    });
    // Field keeps the string (covers format); the page carries the required message.
    expect((pg.properties.email as Record<string, unknown>).errorMessage).toBe("Enter a valid email.");
    expect(pg.errorMessage).toEqual({ required: { email: "Enter a valid email." } });
  });

  test("the object form's `required` key drives the page message; its other keys stay on the field", () => {
    const pg = onePage({
      code: p.string({
        pattern: "^[A-Z]+$",
        required: true,
        errorMessage: { pattern: "Uppercase only.", required: "Code is required." },
      }),
    });
    expect((pg.properties.code as Record<string, unknown>).errorMessage).toEqual({ pattern: "Uppercase only." });
    expect(pg.errorMessage).toEqual({ required: { code: "Code is required." } });
  });

  test("several required fields collect into one errorMessage.required map", () => {
    const pg = onePage({
      a: p.string({ required: true, errorMessage: "A is required." }),
      b: p.string({ required: true, errorMessage: { required: "B is required." } }),
      c: p.string({ required: true }), // no message → absent from the map
    });
    expect(pg.errorMessage).toEqual({ required: { a: "A is required.", b: "B is required." } });
  });

  test("a required message on an OPTIONAL field is dropped (no parent entry, no field key)", () => {
    const pg = onePage({
      opt: p.string({ pattern: "^x$", errorMessage: { pattern: "must be x", required: "never fires" } }),
    });
    expect((pg.properties.opt as Record<string, unknown>).errorMessage).toEqual({ pattern: "must be x" });
    expect(pg.errorMessage).toBeUndefined();
  });

  test("an explicit page `required` list that drops a field also drops its required message", () => {
    // `flagged` carries required:true + a required message, but the page's explicit
    // required list omits it — so no required failure can fire, and no message emits.
    const pg = onePage(
      {
        kept: p.string({ required: true, errorMessage: "Kept is required." }),
        flagged: p.string({ required: true, errorMessage: "Flagged is required." }),
      },
      ["kept"],
    );
    expect(pg.required).toEqual(["kept"]);
    expect(pg.errorMessage).toEqual({ required: { kept: "Kept is required." } });
  });

  test("a page with no errorMessage-bearing param omits the page errorMessage key entirely", () => {
    const pg = onePage({ x: p.string({ required: true }), y: p.string() });
    expect(pg.errorMessage).toBeUndefined();
  });
});

describe("errorMessage — required assembly across pages and dependency branches", () => {
  test("each page collects only its OWN required messages", () => {
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page("One", { a: p.string({ required: true, errorMessage: "A required." }) }),
        page("Two", { b: p.string({ required: true, errorMessage: "B required." }) }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [p1, p2] = pagesOf(new T());
    expect(p1!.errorMessage).toEqual({ required: { a: "A required." } });
    expect(p2!.errorMessage).toEqual({ required: { b: "B required." } });
  });

  test("a showWhen-revealed required field lifts its message to the BRANCH, not the page", () => {
    const style = p.enum(["Layered", "Cupcakes"], { title: "Style", required: true });
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page("P", {
          style,
          topperText: p.string({
            title: "Topper text",
            required: true,
            showWhen: style.is("Layered"),
            errorMessage: "Topper text is required for a layered cake.",
          }),
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    // The page's own errorMessage names only base-field required messages — none here.
    expect(pg!.errorMessage).toBeUndefined();
    const layered = depTree(pg!).style.oneOf.find(
      (b) => (b.properties.style as { const?: unknown }).const === "Layered",
    ) as unknown as { required?: string[]; errorMessage?: unknown };
    expect(layered.required).toEqual(["topperText"]);
    expect(layered.errorMessage).toEqual({ required: { topperText: "Topper text is required for a layered cake." } });
  });

  test("a dep.when branch lifts a revealed required field's message to the branch", () => {
    const packaging = p.enum(["box", "ribbon"], { title: "Packaging" });
    const ribbonColor = p.string({ title: "Ribbon colour", required: true, errorMessage: "Pick a ribbon colour." });
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { packaging },
          dependencies: [dep.when(packaging, [dep.eq("box"), dep.eq("ribbon", { properties: { ribbonColor } })])],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    const ribbon = depTree(pg!).packaging.oneOf.find(
      (b) => (b.properties.packaging as { const?: unknown }).const === "ribbon",
    ) as unknown as { required?: string[]; errorMessage?: unknown };
    expect(ribbon.required).toEqual(["ribbonColor"]);
    expect(ribbon.errorMessage).toEqual({ required: { ribbonColor: "Pick a ribbon colour." } });
  });

  test("an AND-nested (all(...)) required field lifts its message to the deepest branch", () => {
    const orderType = p.enum(["standard", "wedding"], { title: "Order", required: true });
    const topper = p.boolean({ title: "Topper?", showWhen: orderType.is("wedding") });
    class T extends Template {
      id = "t";
      title = "T";
      type = "service";
      pages = [
        page("P", {
          orderType,
          topper,
          topperText: p.string({
            title: "Topper text",
            required: true,
            showWhen: all(orderType.is("wedding"), topper.is(true)),
            errorMessage: "Say what the topper reads.",
          }),
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const [pg] = pagesOf(new T());
    const wedding = depTree(pg!).orderType.oneOf.find(
      (b) => (b.properties.orderType as { const?: unknown }).const === "wedding",
    ) as unknown as { dependencies: { topper: { oneOf: Array<Record<string, unknown>> } } };
    const topperOn = wedding.dependencies.topper.oneOf.find(
      (b) => ((b.properties as Record<string, { const?: unknown }>).topper as { const?: unknown }).const === true,
    ) as { required?: string[]; errorMessage?: unknown };
    expect(topperOn.required).toEqual(["topperText"]);
    expect(topperOn.errorMessage).toEqual({ required: { topperText: "Say what the topper reads." } });
  });
});

describe("errorMessage — the compiled schema stays AJV-valid", () => {
  test("a page carrying errorMessage still validates as a Backstage template entity", async () => {
    const { assertValid } = await import("./index.ts");
    class T extends Template {
      id = "em-valid";
      title = "EM";
      type = "service";
      pages = [
        page("P", {
          email: p.string({ title: "Email", format: "email", required: true, errorMessage: "Enter a valid email." }),
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new T(), nonprod);
    // The unknown `errorMessage` keyword must not trip TDK's entity validator
    // (strict:false) — it is ignored, and the entity validates.
    await assertValid(object);
  });
});

describe("errorMessage — verifier regressions on #67", () => {
  // The MAJOR: the flat `params` form (a class template with no pages) hand-built
  // its schema and never lifted the required message — a missing value rendered
  // ajv's raw phrasing while a malformed one rendered the authored text.
  test("the flat params form lifts the required message like a page does", () => {
    class Flat extends Template {
      id = "flat-error-message";
      title = "Flat";
      type = "service";
      params = { email: p.string({ required: true, errorMessage: "Enter a valid email." }) };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new Flat(), nonprod);
    const params = object.spec.parameters as unknown as Record<string, unknown>;
    expect(params.errorMessage).toEqual({ required: { email: "Enter a valid email." } });
    expect((params.properties as Record<string, Record<string, unknown>>).email!.errorMessage).toBe(
      "Enter a valid email.",
    );
  });

  // The MINOR: a page-level `required: [...]` override can ADD a field the param
  // itself did not flag — the message must follow the FINAL required list.
  test("a field made required only by the page-level override still lifts its message", () => {
    const pg = onePage({ email: p.string({ errorMessage: "Enter a valid email." }) }, ["email"]);
    expect(pg.errorMessage).toEqual({ required: { email: "Enter a valid email." } });
  });

  test("a dep.when branch's explicit required override scopes the lifted messages", () => {
    // The branch requires only `a`; `b`'s message must not lift (its failure can't fire).
    const mode = p.enum(["x", "y"], { required: true });
    class T extends Template {
      id = "t-branch-scope";
      title = "T";
      type = "service";
      pages = [
        page({
          title: "P",
          properties: { mode },
          dependencies: [
            dep.when(mode, [
              dep.eq("x", {
                properties: {
                  a: p.string({ required: true, errorMessage: "A is required." }),
                  b: p.string({ required: true, errorMessage: "B is required." }),
                },
                required: ["a"],
              }),
            ]),
          ],
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const pg = pagesOf(new T())[0]!;
    const branch = (pg.dependencies as Record<string, { oneOf: Record<string, unknown>[] }>).mode!.oneOf[0]!;
    expect(branch.errorMessage).toEqual({ required: { a: "A is required." } });
  });
});
