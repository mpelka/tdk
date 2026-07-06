// SEMANTIC regression tests for the Nunjucks backend fixes, all run through
// the REAL nunjucks engine (differentialNj / renderNj) — emission-string
// checks live in transpile.test.ts.

import { describe, expect, test } from "bun:test";
import { differentialNj, renderNj } from "./differential.ts";
import { NjTranspileError, nj, njDefault, validateNunjucks } from "./index.ts";

describe("M6: ?? / njDefault are null-aware (default filter misses null)", () => {
  type Ctx = { parameters: { region?: string | null } };
  const fixtures = [
    { parameters: { region: "us" } }, // present → kept
    { parameters: { region: null } }, // LITERAL null → fallback (the old | default missed this)
    { parameters: {} }, // absent → fallback
    { parameters: { region: "" } }, // empty string is NOT nullish → kept
  ] as Ctx[];

  test("x ?? v agrees on present / null / absent / empty", () => {
    const e = nj<Ctx>((c) => c.parameters.region ?? "eu");
    const r = differentialNj(e, fixtures);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["us", "eu", "eu", ""]);
  });

  test("njDefault(x, v) agrees on the same fixtures", () => {
    const e = nj<Ctx>((c) => njDefault(c.parameters.region, "eu"));
    expect(differentialNj(e, fixtures).ok).toBe(true);
  });

  test("plain member access renders a literal null as empty (oracle agrees)", () => {
    const e = nj<Ctx>((c) => c.parameters.region);
    const r = differentialNj(e, [{ parameters: { region: null } }] as Ctx[]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("");
  });
});

describe("M7: filtered bases render through the engine", () => {
  test(".trim().length renders (unparenthesized it is 'filter not found')", () => {
    type Ctx = { parameters: { name: string } };
    const e = nj<Ctx>((c) => c.parameters.name.trim().length);
    const r = differentialNj(e, [{ parameters: { name: " ab " } }, { parameters: { name: "brioche" } }]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["2", "7"]);
  });

  test("element access on a filtered base renders", () => {
    type Ctx = { parameters: { name: string } };
    const e = nj<Ctx>((c) => c.parameters.name.trim()[0]);
    const r = differentialNj(e, [{ parameters: { name: "  spelt  " } }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("s");
  });
});

describe("M8: build-time validation of the emitted Nunjucks", () => {
  test("M7-style filter garbage is rejected with the produced string", () => {
    expect(() => validateNunjucks("s | trim.length")).toThrow(NjTranspileError);
    expect(() => validateNunjucks("s | trim.length")).toThrow(/filter not found[\s\S]*produced: s \| trim\.length/);
  });

  test("syntax garbage is rejected at eager-compile", () => {
    expect(() => validateNunjucks("a b")).toThrow(/does not compile\/render/);
  });

  test("valid emissions pass (incl. data-dependent filter throws on empty ctx)", () => {
    expect(() => validateNunjucks("(parameters.name | trim).length")).not.toThrow();
    expect(() => validateNunjucks('(parameters.region if parameters.region != null else "eu")')).not.toThrow();
    expect(() => validateNunjucks('steps["fetch-base"].output.result | upper')).not.toThrow();
  });
});

describe("M9: a render throw is captured, not a harness crash", () => {
  test("differentialNj records the throw as a comparable outcome", () => {
    type Ctx = { parameters: { name?: string } };
    // `| trim` throws a TypeError at render when the value is missing.
    const e = nj<Ctx>((c) => c.parameters.name!.trim());
    let r: ReturnType<typeof differentialNj<Ctx, unknown>> | undefined;
    expect(() => {
      r = differentialNj(e, [{ parameters: {} }]);
    }).not.toThrow();
    expect(String(r!.cases[0]!.actual)).toMatch(/^Error:/);
  });
});

describe("numeric + null fixtures through the engine", () => {
  test("c.parameters.list[0] renders the element", () => {
    type Ctx = { parameters: { list: string[] } };
    const e = nj<Ctx>((c) => c.parameters.list[0]);
    const r = differentialNj(e, [{ parameters: { list: ["madeleine", "palmier"] } }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("madeleine");
  });

  test("computed index renders through the engine", () => {
    type Ctx = { parameters: { list: string[]; i: number } };
    const e = nj<Ctx>((c) => c.parameters.list[c.parameters.i]);
    const r = differentialNj(e, [{ parameters: { list: ["madeleine", "palmier"], i: 1 } }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("palmier");
  });
});

describe('strings containing "}}" render inside {{ ... }}', () => {
  test("the nunjucks lexer respects string literals when scanning for }}", () => {
    const e = nj(() => "a}}b");
    expect(renderNj(e.nunjucks, {})).toBe("a}}b");
    const r = differentialNj(e, [{}] as never[]);
    expect(r.ok).toBe(true);
  });
});

describe("comparisons render with JS semantics (engine-proven)", () => {
  type Ctx = { parameters: { a?: unknown; b?: unknown } };
  const pair = (a: unknown, b: unknown): Ctx => ({ parameters: { a, b } });

  test("=== stays STRICT across type mismatches ('1' === 1 is false)", () => {
    const e = nj<Ctx>((c) => c.parameters.a === c.parameters.b);
    const r = differentialNj(e, [pair("1", 1), pair(1, 1), pair("1", "1"), pair(true, 1), pair(null, undefined)]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["false", "true", "true", "false", "false"]);
  });

  test("!== stays strict too", () => {
    const e = nj<Ctx>((c) => c.parameters.a !== c.parameters.b);
    expect(differentialNj(e, [pair("1", 1), pair(1, 1), pair(null, undefined)]).ok).toBe(true);
  });

  test("== / != stay JS-LOOSE ('1' == 1 is true, null == undefined is true)", () => {
    // biome-ignore lint/suspicious/noDoubleEquals: the loose form is the mapping under test
    const e = nj<Ctx>((c) => c.parameters.a == c.parameters.b);
    const r = differentialNj(e, [pair("1", 1), pair(0, false), pair(null, undefined), pair("a", "b")]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["true", "true", "true", "false"]);
  });

  test("relational operators agree (numbers and strings)", () => {
    const lt = nj<Ctx>((c) => (c.parameters.a as number) < (c.parameters.b as number));
    expect(differentialNj(lt, [pair(1, 2), pair(2, 1), pair("a", "b"), pair(2, 2)]).ok).toBe(true);
    const ge = nj<Ctx>((c) => (c.parameters.a as number) >= (c.parameters.b as number));
    expect(differentialNj(ge, [pair(2, 1), pair(1, 2), pair(2, 2)]).ok).toBe(true);
  });
});

describe("arithmetic renders with JS semantics (engine-proven)", () => {
  type Ctx = { parameters: { a?: unknown; b?: unknown } };
  const pair = (a: unknown, b: unknown): Ctx => ({ parameters: { a, b } });

  test("+ - * / % on numbers", () => {
    type N = { parameters: { a: number; b: number } };
    const fx = [{ parameters: { a: 7, b: 2 } }, { parameters: { a: -3, b: 4 } }];
    expect(
      differentialNj(
        nj<N>((c) => c.parameters.a + c.parameters.b),
        fx,
      ).ok,
    ).toBe(true);
    expect(
      differentialNj(
        nj<N>((c) => c.parameters.a - c.parameters.b),
        fx,
      ).ok,
    ).toBe(true);
    expect(
      differentialNj(
        nj<N>((c) => c.parameters.a * c.parameters.b),
        fx,
      ).ok,
    ).toBe(true);
    expect(
      differentialNj(
        nj<N>((c) => c.parameters.a / c.parameters.b),
        fx,
      ).ok,
    ).toBe(true);
    expect(
      differentialNj(
        nj<N>((c) => c.parameters.a % c.parameters.b),
        fx,
      ).ok,
    ).toBe(true);
  });

  test("+ keeps JS string-concat polymorphism", () => {
    const e = nj<{ parameters: { a: unknown; b: unknown } }>(
      (c) => (c.parameters.a as string) + (c.parameters.b as string),
    );
    const r = differentialNj(e, [pair("a", "b"), pair("n=", 1), pair(1, 2)] as never[]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["ab", "n=1", "3"]);
  });

  test("+ on a MISSING operand renders NaN on both sides", () => {
    const e = nj<{ parameters: { a?: number } }>((c) => (c.parameters.a as number) + 1);
    const r = differentialNj(e, [{ parameters: {} }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("NaN");
  });
});

describe("template literals render like JS (engine-proven)", () => {
  test("string / number / boolean interpolation", () => {
    const e = nj<{ parameters: { name: unknown } }>((c) => `Hi ${c.parameters.name}!`);
    const r = differentialNj(e, [
      { parameters: { name: "Ada" } },
      { parameters: { name: 42 } },
      { parameters: { name: true } },
    ]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["Hi Ada!", "Hi 42!", "Hi true!"]);
  });

  test('null AND undefined interpolate as "null"/"undefined" — exactly like JS (nunjucks ~ uses String())', () => {
    const e = nj<{ parameters: { name?: unknown } }>((c) => `v=${c.parameters.name}`);
    const r = differentialNj(e, [{ parameters: { name: null } }, { parameters: {} }]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["v=null", "v=undefined"]);
  });
});

describe("string method calls render as the real JS methods (engine-proven)", () => {
  test(".split(sep) — the rendered array prints comma-joined on both sides", () => {
    const e = nj<{ parameters: { s: string } }>((c) => c.parameters.s.split("/"));
    const r = differentialNj(e, [{ parameters: { s: "a/b/c" } }, { parameters: { s: "solo" } }]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["a,b,c", "solo"]);
  });

  test(".split()[0] composes with indexing", () => {
    const e = nj<{ parameters: { s: string } }>((c) => c.parameters.s.split("?")[0]);
    const r = differentialNj(e, [{ parameters: { s: "path?query" } }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("path");
  });

  test(".replace replaces the FIRST occurrence only (JS string semantics)", () => {
    const e = nj<{ parameters: { s: string } }>((c) => c.parameters.s.replace("a", "o"));
    const r = differentialNj(e, [{ parameters: { s: "banana" } }, { parameters: { s: "none" } }]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["bonana", "none"]);
  });

  test(".slice supports negative indices (JS string slice)", () => {
    const e1 = nj<{ parameters: { s: string } }>((c) => c.parameters.s.slice(1, 3));
    expect(differentialNj(e1, [{ parameters: { s: "abcdef" } }]).cases[0]!.actual).toBe("bc");
    const e2 = nj<{ parameters: { s: string } }>((c) => c.parameters.s.slice(-2));
    const r2 = differentialNj(e2, [{ parameters: { s: "abcdef" } }]);
    expect(r2.ok).toBe(true);
    expect(r2.cases[0]!.actual).toBe("ef");
  });

  test("a method on a MISSING value throws on BOTH sides (comparable outcomes)", () => {
    const e = nj<{ parameters: { s?: string } }>((c) => c.parameters.s!.split(","));
    const r = differentialNj(e, [{ parameters: {} }]);
    // Both sides throw; messages differ (TypeError vs nunjucks wrapper), so the
    // harness records a mismatch of two Error outcomes — assert both THREW.
    expect(String(r.cases[0]!.expected)).toMatch(/^Error:/);
    expect(String(r.cases[0]!.actual)).toMatch(/^Error:/);
  });
});

describe('m11: x || "" is a plain `or` and composes with filters', () => {
  test("renders identically to the old if/else idiom", () => {
    type Ctx = { parameters: { start?: string } };
    const e = nj<Ctx>((c) => c.parameters.start || "");
    const r = differentialNj(e, [
      { parameters: { start: "09:00" } },
      { parameters: { start: "" } },
      { parameters: {} },
    ]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["09:00", "", ""]);
  });

  test("a FILTERED left operand no longer produces a doubled pipeline", () => {
    type Ctx = { parameters: { name: string } };
    const e = nj<Ctx>((c) => c.parameters.name.trim() || "");
    expect(e.nunjucks).toBe('(parameters.name | trim or "")');
    const r = differentialNj(e, [{ parameters: { name: " tart " } }]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("tart");
  });
});
