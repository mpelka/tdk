// Unit tests for the STATEMENT LAYER: block-bodied arrows and the new
// procedural constructs (const/let bindings, reassignment, return, the block
// emission shape) plus the new operator/function support (assert → $assert,
// .concat → $append, array-literal .includes → membership `in`).
//
// These assert the EXACT JSONata string emitted. They drive `transpileArrowSource`
// on SOURCE STRINGS rather than `jsonata(fn)` on inline arrows: Bun's transpiler
// rewrites the test module before `fn.toString()` runs, and it INLINES a
// single-use `const x = e; return x;` into `return e;` (the same optimizer that
// constant-folds captured primitives). Source strings are immune to that, so we
// can pin the emitted block precisely. The end-to-end `jsonata(fn)` binding path is
// proven by the cake-order benchmark (whose multi-use / reassigned bindings
// survive the optimizer) and the `jsonata(fn)` cases below that also survive it.

import { describe, expect, test } from "bun:test";
import { jsonata, TranspileError } from "../../index.ts";
import { transpileArrowSource } from "./transpile.ts";

/** Emit JSONata from an arrow SOURCE string (optimizer-immune). */
const t = (src: string): string => transpileArrowSource(src);
/** Emit JSONata from a live arrow via `jsonata(fn).compact` (canonical form). */
const js = (fn: (c: any) => unknown): string => jsonata(fn).compact;

describe("block bindings (exact emission)", () => {
  test("const binding → `$x := <e>`", () => {
    expect(t("(c) => { const x = c.a; return x; }")).toBe("($x := a; $x)");
  });

  test("let binding → `$x := <e>`", () => {
    expect(t("(c) => { let x = c.a; return x; }")).toBe("($x := a; $x)");
  });

  test("reassignment rebinds the same variable → `$x := <e>`", () => {
    expect(t("(c) => { let x = c.a; x = c.b; return x; }")).toBe("($x := a; $x := b; $x)");
  });

  test("a bound name resolves under member access → `$x.field`", () => {
    expect(t("(c) => { const o = c.owner; return o.email; }")).toBe("($o := owner; $o.email)");
  });

  test("multiple bindings sequence in source order", () => {
    expect(t("(c) => { const a = c.x; const b = c.y; return { a, b }; }")).toBe(
      '($a := x; $b := y; {"a": $a, "b": $b})',
    );
  });

  test("a bound name is referenced as a JSONata variable everywhere", () => {
    expect(t('(c) => { const n = c.first; return { greeting: "hi " + n, who: n }; }')).toBe(
      '($n := first; {"greeting": ("hi " & $n), "who": $n})',
    );
  });
});

describe("return + block emission (exact emission)", () => {
  test("a single `return` block emits `( <final> )`", () => {
    expect(t("(c) => { return c.x; }")).toBe("(x)");
  });

  test("the returned object literal is the block's final expression", () => {
    expect(t("(c) => { const v = c.x; return { value: v }; }")).toBe('($v := x; {"value": $v})');
  });
});

describe("assert → $assert", () => {
  test("a bare assert statement emits `$assert(<cond>, <msg>)`", () => {
    expect(t('(c) => { assert(c.manager !== "", "no manager"); return c.manager; }')).toBe(
      '($assert((manager != ""), "no manager"); manager)',
    );
  });

  test("assert with the wrong arity is rejected", () => {
    expect(() => t("(c) => { assert(c.ok); return c.ok; }")).toThrow(/at least 2 argument/);
  });
});

describe(".concat → $append", () => {
  test("`a.concat(b)` → `$append(a, b)` (live arrow)", () => {
    expect(js((c) => c.a.concat(c.b))).toBe("$append(a, b)");
  });

  test("concat of a bound var with an array literal", () => {
    expect(t("(c) => { let xs = c.a; xs = xs.concat([c.extra]); return xs; }")).toBe(
      "($xs := a; $xs := $append($xs, [extra]); $xs)",
    );
  });
});

describe("array-literal .includes → membership `in`", () => {
  test('`["a","b"].includes(x)` → `(x in ["a", "b"])` (live arrow)', () => {
    expect(js((c) => ["a", "b"].includes(c.x))).toBe('(x in ["a", "b"])');
  });

  test("string-literal .includes stays $contains (heuristic preserved)", () => {
    expect(js((c) => c.s.includes("z"))).toBe('$contains(s, "z")');
  });

  test("inside a ternary, membership composes (live arrow)", () => {
    expect(js((c) => (["Linux", "Unix"].includes(c.platform) ? "unix" : "other"))).toBe(
      '((platform in ["Linux", "Unix"]) ? "unix" : "other")',
    );
  });
});

describe("statement-layer rejects", () => {
  test("a block with no return is rejected", () => {
    expect(() => t("(c) => { const x = c.a; }")).toThrow(/must end with/);
  });

  test("a statement after `return` is rejected", () => {
    expect(() => t("(c) => { return c.a; const b = c.b; }")).toThrow(/final statement/);
  });

  test("a destructuring binding is rejected", () => {
    expect(() => t("(c) => { const { a } = c; return a; }")).toThrow(/Destructuring/);
  });

  test("an unsupported statement (for-loop) is rejected", () => {
    expect(() => t("(c) => { for (;;) {} return c.a; }")).toThrow(/Unsupported statement/);
  });

  test("a binding without an initializer is rejected", () => {
    expect(() => t("(c) => { let x; return x; }")).toThrow(/must have an initializer/);
  });

  test("reassigning anything other than a bare name is rejected", () => {
    expect(() => t("(c) => { c.x = c.y; return c; }")).toThrow(/Only simple `name = <expr>` reassignment/);
  });

  test("an empty `return;` is rejected", () => {
    expect(() => t("(c) => { return; }")).toThrow(/must `return <expr>;`/);
  });

  test("the rejects are TranspileErrors pointing at the escape hatch", () => {
    try {
      t("(c) => { for (;;) {} return c.a; }");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TranspileError);
      expect((e as Error).message).toContain("raw.jsonata");
    }
  });
});
