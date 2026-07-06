// Edge-case + error-path coverage for the transpiler. These exercise the
// whitelist's reject branches and the less-common emit paths so the supported
// surface (and the exact failure modes) stay locked down.

import { describe, expect, test } from "bun:test";
import { jsonata, TranspileError } from "../../index.ts";
import { transpileArrowSource } from "./transpile.ts";

/** Compile any function's source and return the emitted JSONata (COMPACT form). */
const compile = (fn: (...args: any[]) => unknown): string => jsonata(fn as unknown as (c: any) => unknown).compact;

/** Emit JSONata from an arrow SOURCE string (optimizer-immune). */
const t = (src: string): string => transpileArrowSource(src);

describe("arrow shape", () => {
  test("source with no arrow function at all is rejected", () => {
    expect(() => t("42")).toThrow(/expects an arrow function/);
  });

  test("more than one context parameter is rejected", () => {
    expect(() => compile((a: any, _b: any) => a)).toThrow(/exactly one context parameter/);
  });

  test("a destructured context parameter is rejected", () => {
    expect(() => compile(({ a }: any) => a)).toThrow(/no destructuring/);
  });

  test("a zero-parameter arrow may still return a literal", () => {
    expect(compile(() => 42)).toBe("42");
  });
});

describe("unsupported syntax nodes", () => {
  test("typeof is rejected as unsupported syntax", () => {
    expect(() => compile((c: any) => typeof c.a)).toThrow(/Unsupported syntax/);
  });

  test("a `new` expression is rejected", () => {
    expect(() => compile((c: any) => new Date(c.t))).toThrow(/Unsupported syntax/);
  });

  test("a bare `undefined` identifier maps to JSONata null", () => {
    expect(t("(c) => undefined")).toBe("null");
  });
});

describe("object literal rejects", () => {
  test("an object METHOD is rejected (spreads are supported, methods are not)", () => {
    expect(() => t("(c) => ({ m() { return 1; } })")).toThrow(/plain `key: value`/);
  });

  test("a computed non-literal key is rejected", () => {
    expect(() => compile((c: any) => ({ [c.k]: 1 }))).toThrow(/Object keys must be/);
  });

  test("a computed STRING-LITERAL key is accepted as a path step", () => {
    // biome-ignore lint/complexity/useLiteralKeys: the COMPUTED form is the point — exercises the transpiler's computed-string-literal-key accept branch
    expect(compile((_c: any) => ({ ["a-b"]: 1 }))).toBe('{"a-b": 1}');
  });
});

describe("array spread folds to $append", () => {
  test("two spreads → $append(a, b)", () => {
    expect(compile((c: any) => [...c.a, ...c.b])).toBe("$append(a, b)");
  });
  test("a lone spread is just the spread expression", () => {
    expect(compile((c: any) => [...c.a])).toBe("a");
  });
  test("a mixed run groups plain elements into a segment", () => {
    expect(compile((c: any) => [...c.a, c.x, c.y])).toBe("$append(a, [x, y])");
    expect(compile((c: any) => [c.x, ...c.a])).toBe("$append([x], a)");
  });
});

describe("element access", () => {
  test("a computed index expression is HOISTED into a block variable", () => {
    // A bare `list[i]` would evaluate `i` in ITEM context (a JSONata
    // predicate) — undefined for every element. The hoist keeps the index in
    // the enclosing scope, matching JS.
    expect(compile((c: any) => c.list[c.i])).toBe("($__idx1 := i; list[$__idx1])");
  });

  test("an index that is already a bound variable needs no hoisting", () => {
    expect(t("(c) => { const i = c.offset; return c.list[i]; }")).toBe("($i := offset; list[$i])");
  });

  test("a negative literal index is rejected (JSONata selects from the END there)", () => {
    expect(() => compile((c: any) => c.list[-1])).toThrow(/Negative literal index/);
  });

  test("a non-identifier string key becomes a backtick-quoted step", () => {
    expect(compile((c: any) => c.steps["fetch-base"].output)).toBe("steps.`fetch-base`.output");
  });

  test("a string key containing a backtick is rejected (no escape in JSONata)", () => {
    expect(() => compile((c: any) => c.obj["a`b"])).toThrow(/backtick/);
  });
});

describe("call expression rejects", () => {
  test("calling the result of an element access is rejected", () => {
    expect(() => compile((c: any) => c.fns[0]())).toThrow(/Unsupported call expression/);
  });

  test("an unknown bare global call lists the supported globals (incl. parseInt/parseFloat)", () => {
    expect(() => compile((c: any) => encodeURIComponent(c.s))).toThrow(/Unsupported function call.*parseInt/s);
  });

  test("parseInt's radix argument is rejected, pointing at raw.jsonata", () => {
    expect(() => compile((c: any) => parseInt(c.s, 16))).toThrow(/radix argument is not supported[\s\S]*raw\.jsonata/);
  });
});

describe("lambda-array methods reject bad shapes", () => {
  test(".map() with no lambda is rejected", () => {
    expect(() => compile((c: any) => c.a.map())).toThrow(/exactly one lambda argument/);
  });

  test(".map(nonArrow) is rejected", () => {
    expect(() => compile((c: any) => c.a.map(c.cb))).toThrow(/inline arrow function/);
  });

  test(".map((x, i) => ...) with two params is rejected", () => {
    expect(() => compile((c: any) => c.a.map((x: any, _i: any) => x))).toThrow(/exactly one simple parameter/);
  });

  test(".map(x => { … }) with a block body emits a per-item block (source-string pinned)", () => {
    // Source strings, not live arrows: Bun's optimizer would inline the
    // single-use `const y = …; return y;` before `fn.toString()` runs.
    expect(t("(c) => c.items.map(x => { const y = x.qty; return y; })")).toBe("[items.($y := qty; $y)]");
  });

  test(".filter(x => { … }) wraps the emitted block in $boolean", () => {
    expect(t("(c) => c.items.filter(x => { const y = x.qty; return y > 1; })")).toBe(
      "[items[$boolean(($y := qty; ($y > 1)))]]",
    );
  });

  test("a nested block binding SHADOWS a same-named outer binding (innermost wins)", () => {
    expect(
      t("(c) => { const y = c.base; return { keep: y, mapped: c.items.map(x => { const y = x.qty; return y; }) }; }"),
    ).toBe('($y := base; {"keep": $y, "mapped": [items.($y := qty; $y)]})');
  });
});

describe("array-literal .includes arity", () => {
  test("[...].includes(x, y) with two args is rejected", () => {
    expect(() => t('(c) => ["a", "b"].includes(c.x, c.y)')).toThrow(/takes exactly one argument/);
  });
});

describe("unary edge cases", () => {
  test("unary plus → $number", () => {
    expect(compile((c: any) => +c.s)).toBe("$number(s)");
  });

  test("the minifier idiom !0 / !1 folds back to booleans", () => {
    expect(compile(() => !0)).toBe("true");
    expect(compile(() => !1)).toBe("false");
  });

  test("an unsupported unary operator (~) is rejected", () => {
    expect(() => compile((c: any) => ~c.a)).toThrow(/Unsupported unary operator/);
  });
});

describe("binary `+` string-ish recursion", () => {
  test("a nested `+` chain with a string tail concatenates", () => {
    // biome-ignore lint/style/useTemplate: the `+` chain is the transpiler INPUT under test — it must stay string concatenation, not a template literal
    expect(compile((c: any) => c.a + c.b + "x")).toBe('((a + b) & "x")');
  });
});

describe("arity checks", () => {
  test("too few args (.substring()) is rejected", () => {
    expect(() => compile((c: any) => c.s.substring())).toThrow(/at least 1 argument/);
  });

  test("too many args (.toUpperCase('x')) is rejected", () => {
    expect(() => compile((c: any) => c.s.toUpperCase("x"))).toThrow(/at most 0 argument/);
  });

  test("arity errors carry the offending snippet (at: ...)", () => {
    expect(() => compile((c: any) => c.s.toUpperCase("x"))).toThrow(/at: c\.s\.toUpperCase\("x"\)/);
  });
});

describe("error quality (m8)", () => {
  test("errors carry an author-relative line:col", () => {
    expect(() => t("(c) => c.s.repeat(3)")).toThrow(/line 1, col \d+/);
    // A multi-line block: the offending statement is on line 3.
    expect(() => t("(c) => {\n  const a = c.x;\n  for (;;) {}\n  return a;\n}")).toThrow(/line 3, col 3/);
  });

  test("an unknown Math.* call lists the GLOBALS, not string methods", () => {
    expect(() => compile((c: any) => Math.trunc(c.n))).toThrow(/Supported globals: .*Math\.round/);
    expect(() => compile((c: any) => Math.trunc(c.n))).not.toThrow(/Supported methods/);
  });

  test("the unsupported-method message includes slice/substring/map/filter and .length", () => {
    try {
      compile((c: any) => c.s.repeat(2));
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("slice");
      expect(msg).toContain("substring");
      expect(msg).toContain("map, filter");
      expect(msg).toContain(".length");
    }
  });
});

describe("statement-layer: assignment to an undeclared name", () => {
  test("is rejected (strict-mode JS would ReferenceError)", () => {
    expect(() => t("(c) => { x = c.a; return x; }")).toThrow(/undeclared name "x"/);
  });

  test("reassignment of a DECLARED name still works", () => {
    expect(t("(c) => { let x = c.a; x = c.b; return x; }")).toBe("($x := a; $x := b; $x)");
  });
});

describe("template literal edge cases", () => {
  test('a single interpolation coerces to string via & ""', () => {
    expect(compile((c: any) => `${c.x}`)).toBe('((x) & "")');
  });
});

describe("string escaping in quote()", () => {
  test("tab / carriage-return / backslash are escaped", () => {
    expect(compile(() => "a\tb\rc\\d")).toBe('"a\\tb\\rc\\\\d"');
  });
});

describe("TranspileError shape", () => {
  test("is a named Error carrying the escape-hatch hint", () => {
    try {
      compile((c: any) => c.s.repeat(2));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TranspileError);
      expect((e as Error).name).toBe("TranspileError");
      expect((e as Error).message).toContain("raw.jsonata");
    }
  });
});
