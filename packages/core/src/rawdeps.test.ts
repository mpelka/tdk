// `rawDependencies` / `rawSchema` — the raw JSON-Schema escape hatches on a page.
// A raw `dependencies` entry, a raw top-level `if/then/else`, and a raw `anyOf`
// pass through verbatim, and the compiled entity still validates.

import { beforeEach, describe, expect, test } from "bun:test";
import type { PageObject } from "./index.ts";
import { _resetEnvRegistry, compile, dep, p, page, Template, validate } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

beforeEach(() => _resetEnvRegistry());

function pageOf(tpl: Template): PageObject {
  return (compile(tpl, nonprod).object.spec.parameters as PageObject[])[0]!;
}

describe("rawDependencies merges into the page dependencies", () => {
  const RAW = {
    toggle: {
      oneOf: [
        { properties: { toggle: { const: true }, extra: { type: "string" } } },
        { properties: { toggle: { const: false } } },
      ],
    },
  };

  class T extends Template {
    id = "rawdep";
    title = "RawDep";
    type = "service";
    toggle = p.boolean();
    pages = [
      page({
        title: "P",
        properties: { toggle: this.toggle },
        rawDependencies: RAW,
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("the raw dependency passes through unchanged", () => {
    expect(pageOf(new T()).dependencies).toEqual(RAW);
  });

  test("it coexists with a dep.when dependency on another controller", () => {
    class T2 extends Template {
      id = "rawdep2";
      title = "RawDep2";
      type = "service";
      toggle = p.boolean();
      mode = p.string({ enum: ["a", "b"] });
      pages = [
        page({
          title: "P",
          properties: { toggle: this.toggle, mode: this.mode },
          dependencies: [dep.when(this.mode, [dep.eq("a"), dep.eq("b")])],
          rawDependencies: RAW,
        }),
      ];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    const deps = pageOf(new T2()).dependencies as Record<string, unknown>;
    expect(Object.keys(deps).sort()).toEqual(["mode", "toggle"]);
  });
});

describe("rawSchema merges top-level if/then/else + anyOf", () => {
  class T extends Template {
    id = "rawschema";
    title = "RawSchema";
    type = "service";
    kind = p.string({ enum: ["X", "Y"], required: true });
    pages = [
      page({
        title: "P",
        properties: { kind: this.kind },
        rawSchema: {
          if: { properties: { kind: { const: "X" } } },
          then: { required: ["kind"] },
          else: { required: [] },
          anyOf: [{ properties: { kind: { const: "X" } } }, { properties: { kind: { const: "Y" } } }],
        },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("if/then/else + anyOf pass through unchanged", () => {
    // rawSchema keys land BESIDE the modeled PageObject keys.
    const pg = pageOf(new T()) as PageObject & Record<string, unknown>;
    expect(pg.if).toEqual({ properties: { kind: { const: "X" } } });
    expect(pg.then).toEqual({ required: ["kind"] });
    expect(pg.else).toEqual({ required: [] });
    expect(pg.anyOf).toHaveLength(2);
  });

  test("the entity still validates against the Backstage schema", async () => {
    const { object } = compile(new T(), nonprod);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});
