// `showWhen` — declarative conditional fields fronting `dep.when`.
//
// The headline test authors a nested conditional chain (controller → conditional
// field → deeper conditional field) BOTH ways — via `showWhen` and via the
// equivalent hand-written `dep.when` — and asserts the emitted `dependencies`
// deep-equal. The rest cover the boolean controller (the candles-note
// shape) and compile validity.

import { beforeEach, describe, expect, test } from "bun:test";
import { type DepTree, depTree } from "./__fixtures__/entity-access.ts";
import type { PageObject } from "./index.ts";
import { _resetEnvRegistry, compile, dep, p, page, Template, validate } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

beforeEach(() => _resetEnvRegistry());

function depsOf(tpl: Template): DepTree {
  const [pg] = compile(tpl, nonprod).object.spec.parameters as PageObject[];
  return depTree(pg!);
}

describe("showWhen ⇄ dep.when deep-equality (nested chain)", () => {
  // style → topper (revealed when style=Layered) → topper_text
  // (revealed when style=Layered AND topper=Custom).
  class ViaShowWhen extends Template {
    id = "sw";
    title = "SW";
    type = "service";
    style = p.string({ enum: ["Layered", "Cupcakes"], required: true });
    topper = p.string({ enum: ["Custom", "Standard"], showWhen: { style: "Layered" } });
    specify = p.string({ required: true, showWhen: { style: "Layered", topper: "Custom" } });
    pages = [
      page({
        title: "P",
        properties: {
          style: this.style,
          topper: this.topper,
          topper_text: this.specify,
        },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  // The SAME structure authored by hand with dep.when (full value-set coverage:
  // every controller value gets a branch, matching what showWhen generates).
  class ViaDepWhen extends Template {
    id = "dw";
    title = "DW";
    type = "service";
    style = p.string({ enum: ["Layered", "Cupcakes"], required: true });
    topper = p.string({ enum: ["Custom", "Standard"] });
    specify = p.string({ required: true });
    pages = [
      page({
        title: "P",
        properties: { style: this.style },
        dependencies: [
          dep.when(this.style, [
            dep.eq("Layered", {
              properties: { topper: this.topper },
              dependencies: [
                dep.when(this.topper, [
                  dep.eq("Custom", { properties: { topper_text: this.specify } }),
                  dep.eq("Standard"),
                ]),
              ],
            }),
            dep.eq("Cupcakes"),
          ]),
        ],
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("the compiled dependencies are identical", () => {
    expect(depsOf(new ViaShowWhen())).toEqual(depsOf(new ViaDepWhen()));
  });

  test("the showWhen tree has the expected nested shape", () => {
    expect(depsOf(new ViaShowWhen())).toEqual({
      style: {
        oneOf: [
          {
            properties: {
              style: { const: "Layered" },
              topper: { type: "string", enum: ["Custom", "Standard"] },
            },
            dependencies: {
              topper: {
                oneOf: [
                  {
                    properties: {
                      topper: { const: "Custom" },
                      topper_text: { type: "string" },
                    },
                    required: ["topper_text"],
                  },
                  { properties: { topper: { const: "Standard" } } },
                ],
              },
            },
          },
          { properties: { style: { const: "Cupcakes" } } },
        ],
      },
    });
  });

  test("a conditional field's .ref still resolves (name bound)", () => {
    class T extends ViaShowWhen {
      build() {
        return [{ id: "s", action: "debug:log", input: { v: this.specify.ref } }];
      }
    }
    const { object } = compile(new T(), nonprod);
    expect(object.spec.steps[0]!.input!.v).toBe("${{ parameters.topper_text }}");
  });
});

describe("showWhen with a boolean controller (candles note)", () => {
  class T extends Template {
    id = "att";
    title = "Att";
    type = "service";
    wantsCandles = p.boolean({ title: "Add birthday candles", default: false });
    candlesNote = p.customField({
      type: "string",
      title: "Note",
      uiField: "NoteDisplay",
      uiOptions: { template: "Candles are added at collection." },
      showWhen: { wantsCandles: true },
    });
    pages = [
      page({
        title: "Extras",
        properties: {
          wantsCandles: this.wantsCandles,
          candlesNote: this.candlesNote,
        },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("true branch reveals the note; false branch is empty", () => {
    expect(depsOf(new T())).toEqual({
      wantsCandles: {
        oneOf: [
          {
            properties: {
              wantsCandles: { const: true },
              candlesNote: {
                type: "string",
                title: "Note",
                "ui:field": "NoteDisplay",
                "ui:options": { template: "Candles are added at collection." },
              },
            },
          },
          { properties: { wantsCandles: { const: false } } },
        ],
      },
    });
  });
});

describe("showWhen OR (array value) reveals across multiple branches", () => {
  class T extends Template {
    id = "or";
    title = "Or";
    type = "service";
    size = p.string({ enum: ["S", "M", "L"] });
    note = p.string({ showWhen: { size: ["M", "L"] } });
    pages = [page({ title: "P", properties: { size: this.size, note: this.note } })];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("note appears in the M and L branches but not S", () => {
    const branches = depsOf(new T()).size.oneOf;
    expect(branches[0]).toEqual({ properties: { size: { const: "S" } } });
    expect(branches[1]!.properties.note).toEqual({ type: "string" });
    expect(branches[2]!.properties.note).toEqual({ type: "string" });
  });
});

describe("showWhen compile output is schema-valid", () => {
  test("the nested chain validates against the Backstage schema", async () => {
    class ViaShowWhen extends Template {
      id = "swv";
      title = "SWV";
      type = "service";
      style = p.string({ enum: ["Layered", "Cupcakes"], required: true });
      topper = p.string({ enum: ["Custom", "Standard"], showWhen: { style: "Layered" } });
      specify = p.string({ required: true, showWhen: { style: "Layered", topper: "Custom" } });
      pages = [
        page({
          title: "P",
          properties: {
            style: this.style,
            topper: this.topper,
            topper_text: this.specify,
          },
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const { object } = compile(new ViaShowWhen(), nonprod);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("showWhen rejects cycles", () => {
  test("a → b → a throws with the cycle path", () => {
    class T extends Template {
      id = "cycle";
      title = "Cycle";
      type = "service";
      a = p.string({ enum: ["x"], showWhen: { b: "y" } });
      b = p.string({ enum: ["y"], showWhen: { a: "x" } });
      pages = [page({ title: "P", properties: { a: this.a, b: this.b } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/showWhen cycle: (a → b → a|b → a → b)/);
  });

  test("a self-cycle (a shows when a) throws", () => {
    class T extends Template {
      id = "self-cycle";
      title = "Self Cycle";
      type = "service";
      a = p.string({ enum: ["x"], showWhen: { a: "x" } });
      pages = [page({ title: "P", properties: { a: this.a } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/showWhen cycle: a → a/);
  });
});

describe("showWhen rejects malformed controllers", () => {
  test("a controller with no value set is rejected", () => {
    class T extends Template {
      id = "bad";
      title = "Bad";
      type = "service";
      free = p.string(); // no enum, not boolean → no value set
      child = p.string({ showWhen: { free: "x" } });
      pages = [page({ title: "P", properties: { free: this.free, child: this.child } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/no value set/);
  });

  test("a value outside the controller's value set is rejected", () => {
    class T extends Template {
      id = "bad2";
      title = "Bad2";
      type = "service";
      pick = p.string({ enum: ["a", "b"] });
      child = p.string({ showWhen: { pick: "z" } });
      pages = [page({ title: "P", properties: { pick: this.pick, child: this.child } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/not in the value set of controller/);
  });

  test("an unknown controller is rejected", () => {
    class T extends Template {
      id = "bad3";
      title = "Bad3";
      type = "service";
      child = p.string({ showWhen: { nope: "x" } });
      pages = [page({ title: "P", properties: { child: this.child } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/not a property on this page/);
  });
});
