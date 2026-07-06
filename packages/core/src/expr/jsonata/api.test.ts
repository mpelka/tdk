// Coverage for the `jsonata` API surface (JsonataExpr, isJsonataExpr,
// validateJsonata, the raw.jsonata escape hatch, and the quote helper).

import { describe, expect, test } from "bun:test";
import { isJsonataExpr, JsonataExpr, jsonata, quote, validateJsonata } from "./index.ts";

describe("JsonataExpr", () => {
  test("toString() wraps the compiled JSONata in ${{ ... }}", () => {
    const e = jsonata<{ x: number }>((c) => c.x);
    expect(e.toString()).toBe("${{ x }}");
    expect(String(e)).toBe("${{ x }}");
  });

  test("render() is env-independent", () => {
    const e = jsonata<{ x: number }>((c) => c.x);
    expect(e.render({ env: "test" })).toBe(e.render({ env: "prod" }));
  });

  test("exposes the compiled jsonata and the JS oracle fn", () => {
    const e = jsonata<{ x: number }>((c) => c.x);
    expect(e.jsonata).toBe("x");
    expect(e.fn({ x: 7 })).toBe(7);
  });
});

describe("isJsonataExpr", () => {
  test("true for a JsonataExpr, false for everything else", () => {
    expect(isJsonataExpr(jsonata<{ x: number }>((c) => c.x))).toBe(true);
    expect(isJsonataExpr(new JsonataExpr("x", () => null))).toBe(true);
    expect(isJsonataExpr({})).toBe(false);
    expect(isJsonataExpr(null)).toBe(false);
    expect(isJsonataExpr("x")).toBe(false);
  });
});

describe("validateJsonata", () => {
  test("does not throw for parseable JSONata", () => {
    expect(() => validateJsonata("$uppercase(x)")).not.toThrow();
  });

  test("throws a TranspileError for unparseable JSONata", () => {
    expect(() => validateJsonata("{{{ nope")).toThrow(/does not parse/);
  });
});

describe("raw.jsonata / jsonata.raw escape hatch", () => {
  test("interpolates values and validates the result", () => {
    const field = "amounts";
    const e = jsonata.raw`$sum(parameters.${field})`;
    expect(e.jsonata).toBe("$sum(parameters.amounts)");
  });

  test("has no JS oracle — calling fn throws", () => {
    const e = jsonata.raw`$now()`;
    expect(() => e.fn(undefined)).toThrow(/no JS oracle/);
  });

  test("interpolating a jsonata(...) expression embeds its compiled JSONata", () => {
    const inner = jsonata<{ n: number }>((c) => c.n + 1);
    const e = jsonata.raw`$sum([${inner}, 1])`;
    expect(e.jsonata).toBe("$sum([(n + 1), 1])");
  });

  test("interpolating an OBJECT is rejected with a pointed message (m9)", () => {
    // String({}) is "[object Object]" — splicing that in would produce garbage
    // and blame the transpiler's validation instead of the caller.
    const cfg = { field: "amounts" };
    expect(() => jsonata.raw`$sum(parameters.${cfg})`).toThrow(/interpolation #1 is a object/);
    expect(() => jsonata.raw`$sum(parameters.${cfg})`).not.toThrow(/does not parse/);
  });

  test("interpolating null/undefined is rejected too", () => {
    expect(() => jsonata.raw`$sum(${null})`).toThrow(/interpolation #1 is a null/);
    expect(() => jsonata.raw`$sum(${undefined})`).toThrow(/interpolation #1/);
  });

  test("primitive interpolations still splice verbatim", () => {
    const n = 5;
    expect(jsonata.raw`$number(${n})`.jsonata).toBe("$number(5)");
  });
});

describe("quote helper", () => {
  test("escapes the JSONata-significant characters", () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote("a\\b")).toBe('"a\\\\b"');
    expect(quote("a\nb")).toBe('"a\\nb"');
    expect(quote("plain")).toBe('"plain"');
  });
});
