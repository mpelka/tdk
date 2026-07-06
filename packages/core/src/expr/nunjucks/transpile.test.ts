// Focused unit tests: assert the EXACT Nunjucks string emitted for each
// whitelisted construct, plus that unsupported constructs throw clearly.

import { describe, expect, test } from "bun:test";
import { NjTranspileError, nj, njDefault } from "./index.ts";
import { quote, transpileArrowSourceNj } from "./transpile.ts";

/** Compile a live arrow and return the emitted Nunjucks string (without ${{ }}). */
const n = (fn: (c: any) => unknown): string => nj(fn).nunjucks;
/** Compile from arrow SOURCE (optimizer-immune). */
const t = (src: string): string => transpileArrowSourceNj(src);

describe("roots + member access", () => {
  test("bare context property → root name", () => {
    expect(n((c) => c.user)).toBe("user");
  });
  test("context param is stripped to the root path", () => {
    expect(n((c) => c.parameters.application_code)).toBe("parameters.application_code");
  });
  test("deep member access flattens to a dotted path", () => {
    expect(n((c) => c.user.entity.metadata.name)).toBe("user.entity.metadata.name");
  });
  test("each root is supported", () => {
    expect(n((c) => c.parameters.x)).toBe("parameters.x");
    expect(n((c) => c.steps.x)).toBe("steps.x");
    expect(n((c) => c.secrets.token)).toBe("secrets.token");
    expect(n((c) => c.user.ref)).toBe("user.ref");
  });
});

describe("step refs via bracket + string literal (preserved verbatim)", () => {
  test("hyphenated step id keeps its brackets + quotes", () => {
    expect(n((c) => c.steps["requester-manager-fetch"].output.body.x)).toBe(
      'steps["requester-manager-fetch"].output.body.x',
    );
  });
  test("the literal id is NOT camelCase-converted", () => {
    expect(n((c) => c.steps["customer-id-fetch"].output.result)).toBe('steps["customer-id-fetch"].output.result');
  });
  test("numeric index stays a bracket index", () => {
    expect(n((c) => c.parameters.list[0])).toBe("parameters.list[0]");
  });
});

describe("boolean operators", () => {
  test("|| → or", () => {
    expect(n((c) => c.parameters.a || c.parameters.b)).toBe("(parameters.a or parameters.b)");
  });
  test("&& → and", () => {
    expect(n((c) => c.parameters.a && c.parameters.b)).toBe("(parameters.a and parameters.b)");
  });
});

describe("ternary → Nunjucks inline if", () => {
  test("cond ? a : b → (a if cond else b)", () => {
    expect(n((c) => (c.parameters.flag ? "yes" : "no"))).toBe('("yes" if parameters.flag else "no")');
  });
});

describe("default idioms", () => {
  test('x || "" is a plain `or` (nunjucks or IS value-returning)', () => {
    expect(n((c) => c.parameters.scheduled_start || "")).toBe('(parameters.scheduled_start or "")');
  });
  test("x ?? v → null-aware inline if (default filter misses null)", () => {
    // `| default(v)` fires only on UNDEFINED — a present null slips through,
    // diverging from JS `??`. The inline-if is nullish for both.
    expect(n((c) => c.parameters.region ?? "eu")).toBe('(parameters.region if parameters.region != null else "eu")');
  });
  test("njDefault(x, v) compiles the same as ??", () => {
    expect(n((c) => njDefault(c.parameters.region, "eu"))).toBe(
      '(parameters.region if parameters.region != null else "eu")',
    );
  });
});

describe("string filters", () => {
  test(".toUpperCase() → | upper", () => {
    expect(n((c) => c.parameters.name.toUpperCase())).toBe("parameters.name | upper");
  });
  test(".toLowerCase() → | lower", () => {
    expect(n((c) => c.parameters.name.toLowerCase())).toBe("parameters.name | lower");
  });
  test(".trim() → | trim", () => {
    expect(n((c) => c.parameters.name.trim())).toBe("parameters.name | trim");
  });
  test("filters chain left-to-right", () => {
    expect(n((c) => c.parameters.name.trim().toUpperCase())).toBe("parameters.name | trim | upper");
  });
});

describe("the 'or | upper' showcase", () => {
  test("a or b | upper composes with filter binding tighter than or", () => {
    expect(n((c) => c.user.entity.metadata.name || c.steps["customer-id-fetch"].output.result.toUpperCase())).toBe(
      '(user.entity.metadata.name or steps["customer-id-fetch"].output.result | upper)',
    );
  });
});

describe("comparisons + arithmetic pass through (Nunjucks compiles them to JS ops)", () => {
  test("=== / !== stay STRICT", () => {
    expect(n((c) => c.parameters.a === c.parameters.b)).toBe("(parameters.a === parameters.b)");
    expect(n((c) => c.parameters.a !== c.parameters.b)).toBe("(parameters.a !== parameters.b)");
  });
  test("== / != stay JS-loose", () => {
    // biome-ignore lint/suspicious/noDoubleEquals: the loose form is the transpiler INPUT under test — nunjucks == IS JS ==
    expect(n((c) => c.parameters.a == c.parameters.b)).toBe("(parameters.a == parameters.b)");
  });
  test("relational operators pass through", () => {
    expect(n((c) => c.parameters.a < c.parameters.b)).toBe("(parameters.a < parameters.b)");
    expect(n((c) => c.parameters.a >= 3)).toBe("(parameters.a >= 3)");
  });
  test("arithmetic passes through (+ keeps JS string-concat polymorphism)", () => {
    expect(n((c) => c.parameters.a + c.parameters.b)).toBe("(parameters.a + parameters.b)");
    expect(n((c) => c.parameters.a - 1)).toBe("(parameters.a - 1)");
    expect(n((c) => c.parameters.a * 2)).toBe("(parameters.a * 2)");
    expect(n((c) => c.parameters.a / 2)).toBe("(parameters.a / 2)");
    expect(n((c) => c.parameters.a % 2)).toBe("(parameters.a % 2)");
  });
  test("comparisons compose with the ternary", () => {
    expect(n((c) => (c.parameters.n > 3 ? "big" : "small"))).toBe('("big" if (parameters.n > 3) else "small")');
  });
});

describe("template literals → ~ concatenation", () => {
  test('`a${x}b` → ("a" ~ (x) ~ "b")', () => {
    expect(t("(c) => `Hi ${c.parameters.name}!`")).toBe('("Hi " ~ (parameters.name) ~ "!")');
  });
  test('a single bare interpolation coerces to string via ~""', () => {
    expect(t("(c) => `${c.parameters.n}`")).toBe('((parameters.n) ~ "")');
  });
  test("interpolations may be full expressions", () => {
    expect(t("(c) => `n=${c.parameters.a + 1}`")).toBe('("n=" ~ ((parameters.a + 1)))');
  });
});

describe("string METHOD calls kept verbatim (split / replace / slice)", () => {
  test(".split(sep)", () => {
    expect(n((c) => c.parameters.s.split(","))).toBe('parameters.s.split(",")');
  });
  test(".replace(a, b)", () => {
    expect(n((c) => c.parameters.s.replace("a", "o"))).toBe('parameters.s.replace("a", "o")');
  });
  test(".slice(start, end?) — incl. negative indices", () => {
    expect(n((c) => c.parameters.s.slice(1, 3))).toBe("parameters.s.slice(1, 3)");
    expect(n((c) => c.parameters.s.slice(2))).toBe("parameters.s.slice(2)");
  });
  test("a filtered base is parenthesized like any other access", () => {
    expect(n((c) => c.parameters.s.trim().split(","))).toBe('(parameters.s | trim).split(",")');
  });
  test("indexing a split result works", () => {
    expect(n((c) => c.parameters.s.split("/")[0])).toBe('parameters.s.split("/")[0]');
  });
  test("wrong arity is rejected", () => {
    expect(() => t("(c) => c.parameters.s.split()")).toThrow(/exactly one argument/);
    expect(() => t('(c) => c.parameters.s.replace("a")')).toThrow(/exactly two arguments/);
    expect(() => t("(c) => c.parameters.s.slice(1, 2, 3)")).toThrow(/one or two arguments/);
  });
  test("a method call on the bare context is rejected", () => {
    expect(() => t('(c) => c.split(",")')).toThrow(/bare context/);
  });
});

describe("literals", () => {
  test("string / number / boolean", () => {
    expect(n(() => "hi")).toBe('"hi"');
    expect(n(() => 42)).toBe("42");
    expect(n(() => true)).toBe("true");
    expect(n(() => false)).toBe("false");
  });
  test("string escaping", () => {
    expect(t('(c) => "a\\"b"')).toBe('"a\\"b"');
  });
  test("the Bun minifier idiom !0 / !1 folds back to booleans", () => {
    // Driven from source so the idiom is deterministic (Bun may emit `true`
    // literally OR as `!0` depending on optimization; the source form pins it).
    expect(t("() => !0")).toBe("true");
    expect(t("() => !1")).toBe("false");
  });
});

describe("unsupported constructs throw a clear, located error", () => {
  test("block-bodied arrow is rejected", () => {
    expect(() => t("(c) => { return c.user; }")).toThrow(/does not support block-bodied/);
  });
  test("an out-of-subset binary operator (&) is rejected", () => {
    expect(() => t("(c) => c.parameters.a & c.parameters.b")).toThrow(/Unsupported binary operator/);
  });
  test("unsupported method points at the raw escape hatch", () => {
    expect(() => n((c) => c.parameters.s.padStart(3))).toThrow(/raw`/);
  });
  test("external variable reference is rejected", () => {
    const cfg = { region: "eu" };
    expect(() => n(() => cfg.region)).toThrow(/external variables|Unknown reference/);
  });
  test("bare context reference is rejected", () => {
    expect(() => t("(c) => c")).toThrow(/bare context/);
  });
  test("more than one parameter is rejected", () => {
    expect(() => t("(a, b) => a.x")).toThrow(/exactly one context parameter/);
  });
  test("a destructured parameter is rejected", () => {
    expect(() => t("({ a }) => a")).toThrow(/no destructuring/);
  });
  test("source with no arrow is rejected", () => {
    expect(() => t("42")).toThrow(/expects an arrow function/);
  });
  test("rejects are NjTranspileErrors carrying the raw hint", () => {
    try {
      n((c) => c.parameters.s.padStart(2));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NjTranspileError);
      expect((e as Error).message).toContain("raw`");
    }
  });

  test("an unsupported syntax node (array literal) is rejected", () => {
    expect(() => n((c) => [c.user])).toThrow(/Unsupported syntax/);
  });

  test("an object literal is rejected", () => {
    expect(() => t("(c) => ({ a: c.user })")).toThrow(/Unsupported syntax/);
  });

  test("njDefault with the wrong arity is rejected", () => {
    expect(() => t("(c) => njDefault(c.parameters.x)")).toThrow(/exactly two arguments/);
  });

  test("a string filter given arguments is rejected", () => {
    expect(() => t('(c) => c.parameters.s.trim("x")')).toThrow(/takes no arguments/);
  });

  test("calling the result of an element access is rejected", () => {
    expect(() => t("(c) => c.fns[0]()")).toThrow(/Unsupported call expression/);
  });

  test("an unsupported unary operator (-) is rejected", () => {
    expect(() => n((c) => -c.parameters.n)).toThrow(/Unsupported unary operator/);
  });
});

describe("element + root access edge cases", () => {
  test("computed (non-literal) index → bracket index", () => {
    expect(n((c) => c.parameters.list[c.parameters.i])).toBe("parameters.list[parameters.i]");
  });
  test("string key at the root becomes a bare root variable", () => {
    // biome-ignore lint/complexity/useLiteralKeys: the bracket root-key access is the transpiler INPUT under test
    expect(n((c) => c["parameters"].application_code)).toBe("parameters.application_code");
  });
  test("NUMERIC index on the bare context is rejected (would emit a bare literal)", () => {
    expect(() => n((c) => c[0])).toThrow(/bare context/);
  });
  test("COMPUTED index on the bare context is rejected", () => {
    expect(() => n((c) => c[c.k])).toThrow(/bare context/);
  });
});

describe("filtered bases are parenthesized (M7)", () => {
  test("property access on a filter pipeline", () => {
    expect(n((c) => c.parameters.name.trim().length)).toBe("(parameters.name | trim).length");
  });
  test("element access on a filter pipeline", () => {
    expect(n((c) => c.parameters.name.trim()[0])).toBe("(parameters.name | trim)[0]");
  });
  test("plain property chains stay unparenthesized", () => {
    expect(n((c) => c.parameters.a.b)).toBe("parameters.a.b");
  });
});

describe("quote() escapes Nunjucks-significant characters", () => {
  test("double-quote / backslash / newline / CR / tab", () => {
    expect(quote('a"b')).toBe('"a\\"b"');
    expect(quote("a\\b")).toBe('"a\\\\b"');
    expect(quote("a\nb")).toBe('"a\\nb"');
    expect(quote("a\rb")).toBe('"a\\rb"');
    expect(quote("a\tb")).toBe('"a\\tb"');
    expect(quote("plain")).toBe('"plain"');
  });
});

describe("NjTranspileError", () => {
  test("carries the raw hint with and without a snippet", () => {
    const withSnippet = new NjTranspileError("bad", "x.y");
    expect(withSnippet.message).toContain("at: x.y");
    expect(withSnippet.message).toContain("raw`");
    const noSnippet = new NjTranspileError("bad");
    expect(noSnippet.message).not.toContain("at:");
    expect(noSnippet.message).toContain("raw`");
  });
});
