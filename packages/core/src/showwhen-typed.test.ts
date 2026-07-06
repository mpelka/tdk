// Typed `showWhen` — ref-based conditions (`param.is(v)` / `param.in(...)` /
// `all(...)`) the editor can literal-check.
//
// The load-bearing claim is EQUIVALENCE: a marker condition must compile to the
// IDENTICAL parameters as the record form it stands in for. The paired templates
// below assert byte-equality of the compiled `spec.parameters` (a page-based and a
// flat-params pair), then the OR (`.in`) semantics, mixed record+marker usage, and
// the loud throw when a marker names a param outside the form.

import { describe, expect, test } from "bun:test";
import { all, compile, type PageObject, p, page, Template } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

/** The compiled `spec.parameters`, serialized for byte-equality assertions. */
function paramsJson(tpl: Template): string {
  return JSON.stringify(compile(tpl, nonprod).object.spec.parameters);
}

describe("markers compile identically to the record form (page-based)", () => {
  // A two-level chain (orderType=wedding → topper → topperText) authored BOTH ways.
  class ViaMarkers extends Template {
    id = "m";
    title = "M";
    type = "service";
    orderType = p.enum(["standard", "custom", "wedding"], { required: true });
    tiers = p.number({ title: "Tiers", showWhen: this.orderType.is("wedding") });
    topper = p.boolean({ title: "Topper?", showWhen: this.orderType.is("wedding") });
    topperText = p.string({ title: "Topper text", showWhen: all(this.orderType.is("wedding"), this.topper.is(true)) });
    pages = [
      page({
        title: "P",
        properties: { orderType: this.orderType, tiers: this.tiers, topper: this.topper, topperText: this.topperText },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  class ViaRecord extends Template {
    id = "r";
    title = "R";
    type = "service";
    orderType = p.enum(["standard", "custom", "wedding"], { required: true });
    tiers = p.number({ title: "Tiers", showWhen: { orderType: "wedding" } });
    topper = p.boolean({ title: "Topper?", showWhen: { orderType: "wedding" } });
    topperText = p.string({ title: "Topper text", showWhen: { orderType: "wedding", topper: true } });
    pages = [
      page({
        title: "P",
        properties: { orderType: this.orderType, tiers: this.tiers, topper: this.topper, topperText: this.topperText },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("the compiled parameters are byte-identical", () => {
    expect(paramsJson(new ViaMarkers())).toBe(paramsJson(new ViaRecord()));
  });
});

describe("markers compile identically to the record form (flat params)", () => {
  // Flat `params` never compiles showWhen to dependencies — the assertion is that
  // the marker form is nonetheless the exact same output as the record form here.
  class ViaMarkers extends Template {
    id = "fm";
    title = "FM";
    type = "service";
    orderType = p.enum(["standard", "custom", "wedding"], { required: true });
    note = p.string({ title: "Note", showWhen: this.orderType.is("wedding") });
    params = { orderType: this.orderType, note: this.note };
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  class ViaRecord extends Template {
    id = "fr";
    title = "FR";
    type = "service";
    orderType = p.enum(["standard", "custom", "wedding"], { required: true });
    note = p.string({ title: "Note", showWhen: { orderType: "wedding" } });
    params = { orderType: this.orderType, note: this.note };
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("the compiled parameters are byte-identical", () => {
    expect(paramsJson(new ViaMarkers())).toBe(paramsJson(new ViaRecord()));
  });
});

describe(".in is the OR (array-value) form", () => {
  class ViaMarker extends Template {
    id = "or-m";
    title = "OrM";
    type = "service";
    size = p.enum(["S", "M", "L"]);
    note = p.string({ showWhen: this.size.in("M", "L") });
    pages = [page({ title: "P", properties: { size: this.size, note: this.note } })];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  class ViaRecord extends Template {
    id = "or-r";
    title = "OrR";
    type = "service";
    size = p.enum(["S", "M", "L"]);
    note = p.string({ showWhen: { size: ["M", "L"] } });
    pages = [page({ title: "P", properties: { size: this.size, note: this.note } })];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("param.in('M', 'L') === { size: ['M', 'L'] }", () => {
    expect(paramsJson(new ViaMarker())).toBe(paramsJson(new ViaRecord()));
  });
});

describe("record and marker forms mix within one page", () => {
  // One conditional field authored with a marker, another with the record form —
  // on the same page, driven by distinct controllers.
  class Mixed extends Template {
    id = "mix";
    title = "Mix";
    type = "service";
    orderType = p.enum(["standard", "wedding"], { required: true });
    rush = p.boolean({ title: "Rush?" });
    tiers = p.number({ title: "Tiers", showWhen: this.orderType.is("wedding") }); // marker
    rushWhy = p.string({ title: "Why urgent?", showWhen: { rush: true } }); // record
    pages = [
      page({
        title: "P",
        properties: { orderType: this.orderType, rush: this.rush, tiers: this.tiers, rushWhy: this.rushWhy },
      }),
    ];
    build() {
      return [{ id: "s", action: "debug:log" }];
    }
  }

  test("both controllers get their own dependency tree", () => {
    const [pg] = compile(new Mixed(), nonprod).object.spec.parameters as PageObject[];
    const deps = pg!.dependencies as Record<string, { oneOf: unknown[] }>;
    expect(Object.keys(deps).sort()).toEqual(["orderType", "rush"]);
  });
});

describe("a marker naming a param outside the form throws", () => {
  test("an unbound controller is rejected, pointing at the fix", () => {
    // `orphan` is never declared as a property on the page, so it never binds.
    const orphan = p.enum(["a", "b"]);
    class T extends Template {
      id = "orphan";
      title = "Orphan";
      type = "service";
      note = p.string({ showWhen: orphan.is("a") });
      pages = [page({ title: "P", properties: { note: this.note } })];
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/not part of this form\/page/);
  });
});
