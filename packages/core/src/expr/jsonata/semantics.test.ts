// SEMANTIC regression tests for the transpiler fixes — every case here runs
// DIFFERENTIALLY (the author's TS oracle vs the real JSONata engine), so a fix
// can't regress into an emission that merely parses. Emission-string checks
// live in transpile.test.ts / transpile.edge.test.ts; this file proves the
// emitted JSONata *evaluates* like the JS.

import { describe, expect, test } from "bun:test";
import { assertDifferential, differential, jsonata } from "../../index.ts";
import { transpileArrowSource } from "./transpile.ts";

/** Emit JSONata from an arrow SOURCE string (optimizer-immune). */
const t = (src: string): string => transpileArrowSource(src);

describe("C1: || and && preserve the VALUE like JS", () => {
  test("|| falls back only on falsy and keeps the left value otherwise", async () => {
    const e = jsonata<{ name?: string | number | null }>((c) => c.name || "unknown");
    await assertDifferential(e, [
      { name: "vanilla" }, // truthy → the VALUE, not `true`
      { name: "" }, // falsy string → fallback
      { name: 0 }, // falsy number → fallback
      { name: null }, // null → fallback
      {}, // missing → fallback
    ]);
  });

  test("&& keeps the falsy left / returns the right like JS", async () => {
    const e = jsonata<{ a?: unknown; b?: unknown }>((c) => c.a && c.b);
    await assertDifferential(e, [
      { a: "x", b: "y" }, // truthy → right value
      { a: 0, b: "y" }, // falsy → LEFT value (0, not false)
      { a: "", b: "y" },
      { a: true, b: 0 },
      {}, // missing left → missing (both sides undefined)
    ]);
  });

  test("|| chains (a || b || c) evaluate left-to-right", async () => {
    const e = jsonata<{ a?: string; b?: string }>((c) => c.a || c.b || "last");
    await assertDifferential(e, [{ a: "first" }, { b: "second" }, { a: "", b: "second" }, {}]);
  });

  test("|| inside a ternary condition still selects correctly", async () => {
    const e = jsonata<{ flag?: boolean; fallback?: boolean }>((c) => (c.flag || c.fallback ? "y" : "n"));
    await assertDifferential(e, [{ flag: true }, { fallback: true }, { flag: false, fallback: false }, {}]);
  });

  test("a generated temp never captures an author binding of the same name", () => {
    // The author binds `__or1`; the generated temp must skip to `__or2`. The
    // left operand is a CALL (`.join()`) — not a simple pure operand — so a temp
    // is actually generated (a simple left would inline and allocate nothing).
    expect(t("(c) => { const __or1 = c.x; return { a: __or1, b: c.tags.join() || __or1 }; }")).toBe(
      '($__or1 := x; {"a": $__or1, "b": ($__or2 := $join(tags, ","); $boolean($__or2) ? $__or2 : $__or1)})',
    );
  });
});

describe("C1b: readable emission — simple operands inline, complex operands keep the temp", () => {
  // The inlined `$boolean(a) ? a : b` and the temp-guarded
  // `($__or := a; $boolean($__or) ? $__or : b)` must evaluate IDENTICALLY. Both
  // shapes go through the real engine vs the JS oracle for every construct.

  // A property-access left operand INLINES (no temp).
  test("|| with a simple (path) left operand inlines and evaluates like JS", async () => {
    const e = jsonata<{ a?: unknown; b?: unknown }>((c) => c.a || c.b);
    expect(e.jsonata).not.toContain("$__"); // proves the INLINED shape
    await assertDifferential(e, [
      { a: "x", b: "y" },
      { a: "", b: "y" },
      { a: 0, b: 7 },
      { a: null, b: "fallback" },
      {},
    ]);
  });

  test("&& with a simple (path) left operand inlines and evaluates like JS", async () => {
    const e = jsonata<{ a?: unknown; b?: unknown }>((c) => c.a && c.b);
    expect(e.jsonata).not.toContain("$__");
    await assertDifferential(e, [{ a: "x", b: "y" }, { a: 0, b: "y" }, { a: true, b: 0 }, {}]);
  });

  // A CALL left operand KEEPS its temp — the nondeterminism/double-eval guard.
  // A call may be costly or nondeterministic ($millis/$random), so it must be
  // evaluated exactly once; inlining it would be a correctness bug, not just a
  // readability one. The differential still proves value-equivalence with JS.
  test("|| with a CALL left operand keeps its temp (evaluated once) and matches JS", async () => {
    const e = jsonata<{ tags: string[]; b?: unknown }>((c) => c.tags.join(",") || c.b);
    expect(e.jsonata).toContain("$__or"); // the temp is REQUIRED here
    await assertDifferential(e, [
      { tags: ["a", "b"], b: "x" },
      { tags: [], b: "fallback" },
      { tags: [], b: 0 },
    ]);
  });

  test("&& with a CALL left operand keeps its temp and matches JS", async () => {
    const e = jsonata<{ tags: string[]; b?: unknown }>((c) => c.tags.join(",") && c.b);
    expect(e.jsonata).toContain("$__and");
    await assertDifferential(e, [
      { tags: ["a", "b"], b: "x" },
      { tags: [], b: "fallback" },
      { tags: ["a"], b: 0 },
    ]);
  });

  // `.length`: simple receiver inlines the type-dispatch shim; a call receiver
  // stashes it. Both must be exact for strings AND arrays (and the array-length
  // path where `$count(str)` alone would be wrong).
  test(".length inlines for a simple receiver and matches JS for strings and arrays", async () => {
    const e = jsonata<{ members: unknown }>((c) => (c.members as unknown[]).length);
    expect(e.jsonata).not.toContain("$__len");
    await assertDifferential(e, [{ members: [1, 2, 3] }, { members: [] }, { members: "brioche" as never }]);
  });

  test(".length keeps a temp for a CALL receiver and matches JS", async () => {
    const e = jsonata<{ tags: string[]; more: string[] }>((c) => c.tags.concat(c.more).length);
    expect(e.jsonata).toContain("$__len");
    await assertDifferential(e, [
      { tags: ["a", "b"], more: ["c"] },
      { tags: [], more: [] },
    ]);
  });

  // A block-bound const is a simple operand too (`$x` is a pure variable lookup).
  test("a block-bound const left operand inlines (still a pure lookup)", () => {
    expect(t("(c) => { const base = c.baseFee; return base || 0; }")).toBe(
      "($base := baseFee; ($boolean($base) ? $base : 0))",
    );
  });

  // The chained case: inner inlines, outer keeps its temp (its left is a ternary).
  test("a || b || c: inner inlines, the outer left (a conditional) keeps its temp", async () => {
    // The COMPACT emission (t()) shows the shape; `.jsonata` is pretty-printed.
    expect(t('(c) => c.a || c.b || "last"')).toBe(
      '($__or1 := ($boolean(a) ? a : b); $boolean($__or1) ? $__or1 : "last")',
    );
    const e = jsonata<{ a?: string; b?: string }>((c) => c.a || c.b || "last");
    await assertDifferential(e, [{ a: "first" }, { b: "second" }, { a: "", b: "second" }, {}]);
  });
});

describe("C2: .substring applies JS clamp-and-swap at transpile time", () => {
  test("start !== 0 slices correctly ($substring takes a LENGTH, not an end)", async () => {
    // Naive arg pass-through would emit $substring(s, 1, 4) = 4 CHARS from 1.
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.substring(1, 4)),
      [{ s: "chocolate" }, { s: "ab" }, { s: "" }],
    );
  });

  test("swapped arguments (start > end) behave like JS .substring", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.substring(4, 1)),
      [{ s: "chocolate" }, { s: "ab" }],
    );
  });

  test("the one-argument form (incl. past-the-end start)", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.substring(2)),
      [{ s: "chocolate" }, { s: "ab" }, { s: "" }],
    );
  });

  test("emission applies min/abs: .substring(4, 1) → $substring(s, 1, 3)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.substring(4, 1)).jsonata).toBe("$substring(s, 1, 3)");
  });

  test("computed indices are rejected with a pointer at .slice / raw.jsonata", () => {
    expect(() => jsonata<{ s: string; i: number }>((c) => c.s.substring(c.i))).toThrow(/non-negative integer literal/);
    expect(() => jsonata<{ s: string; i: number }>((c) => c.s.substring(0, c.i))).toThrow(/\.slice|raw\.jsonata/);
  });
});

describe("C3: non-identifier string keys become backtick steps", () => {
  test('steps["fetch-base"].output style access evaluates (not subtraction)', async () => {
    const e = jsonata<{ steps: Record<string, { output: { url: string } }> }>((c) => c.steps["fetch-base"].output.url);
    expect(e.jsonata).toBe("steps.`fetch-base`.output.url");
    await assertDifferential(e, [{ steps: { "fetch-base": { output: { url: "https://bakery/cakes" } } } }]);
  });

  test("a hyphenated key at the ROOT works too", async () => {
    const e = jsonata<Record<string, number>>((c) => c["cake-count"]);
    expect(e.jsonata).toBe("`cake-count`");
    await assertDifferential(e, [{ "cake-count": 7 }]);
  });
});

describe("C4: computed element access is hoisted out of item context", () => {
  test("c.list[c.i] indexes with the OUTER value of i", async () => {
    const e = jsonata<{ flavours: string[]; i: number }>((c) => c.flavours[c.i]);
    await assertDifferential(e, [
      { flavours: ["vanilla", "chocolate", "pistachio"], i: 1 },
      { flavours: ["vanilla", "chocolate"], i: 0 },
      { flavours: ["vanilla"], i: 5 }, // out of range → undefined on both sides
    ]);
  });

  test("an index expression (arithmetic) also hoists", async () => {
    const e = jsonata<{ flavours: string[]; i: number }>((c) => c.flavours[c.i - 1]);
    await assertDifferential(e, [{ flavours: ["vanilla", "chocolate"], i: 2 }]);
  });
});

describe("M1: .replace replaces the FIRST occurrence; .replaceAll all", () => {
  test(".replace with a multi-occurrence input", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.replace("a", "o")),
      [{ s: "banana" }, { s: "no-match" }, { s: "" }],
    );
  });

  test(".replaceAll with a multi-occurrence input", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.replaceAll("a", "o")),
      [{ s: "banana" }, { s: "no-match" }],
    );
  });
});

describe("M2: .length is exact for BOTH strings and arrays", () => {
  test("string .length (was $count → 1 for any string)", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.length),
      [{ s: "chocolate" }, { s: "" }, { s: "x" }],
    );
  });

  test("array .length still counts elements", async () => {
    await assertDifferential(
      jsonata<{ items: number[] }>((c) => c.items.length),
      [{ items: [1, 2, 3] }, { items: [42] }],
    );
  });

  test(".filter().length composes through the shim", async () => {
    const e = jsonata<{ items: { qty: number }[] }>((c) => c.items.filter((x) => x.qty > 1).length);
    await assertDifferential(e, [{ items: [{ qty: 1 }, { qty: 2 }, { qty: 3 }] }, { items: [{ qty: 0 }] }]);
  });
});

describe("M3: numeric filter predicates test truthiness (not index lookup)", () => {
  test(".filter(x => x.qty) keeps truthy-qty items like JS", async () => {
    const e = jsonata<{ items: { qty: number; name: string }[] }>((c) => c.items.filter((x) => x.qty));
    await assertDifferential(e, [
      {
        items: [
          { qty: 1, name: "eclair" },
          { qty: 0, name: "scone" },
          { qty: 2, name: "tart" },
        ],
      },
    ]);
  });

  test("comparison predicates still work wrapped in $boolean", async () => {
    const e = jsonata<{ items: { qty: number }[] }>((c) => c.items.filter((x) => x.qty > 1));
    await assertDifferential(e, [{ items: [{ qty: 1 }, { qty: 2 }] }]);
  });
});

describe("M4: lambda params SHADOW same-named block bindings and the context", () => {
  test("a lambda param shadowing a block binding resolves to the ITEM", () => {
    // Before the fix `x` inside the lambda resolved to the outer `$x`.
    expect(t("(c) => { const x = c.prefix; return { keep: x, mapped: c.items.map(x => x.b) }; }")).toBe(
      '($x := prefix; {"keep": $x, "mapped": [items.b]})',
    );
  });

  test("a lambda param shadowing the CONTEXT param resolves to the item", () => {
    expect(t("(c) => c.items.map(c => c.b)")).toBe("[items.b]");
  });

  test("differential: shadowed binding maps over items, not the binding", async () => {
    const e = jsonata<{ prefix: string; items: { b: string }[] }>((c) => {
      const x = c.prefix;
      return { keep: x, mapped: c.items.map((x) => x.b) };
    });
    await assertDifferential(e, [{ prefix: "cake", items: [{ b: "one" }, { b: "two" }] }]);
  });
});

describe("M5: bare .join() defaults to the JS ',' separator", () => {
  test("emission injects the comma", () => {
    expect(jsonata<{ tags: string[] }>((c) => c.tags.join()).jsonata).toBe('$join(tags, ",")');
  });

  test("differential across sizes", async () => {
    await assertDifferential(
      jsonata<{ tags: string[] }>((c) => c.tags.join()),
      [{ tags: ["a", "b", "c"] }, { tags: ["solo"] }],
    );
  });
});

describe("m1: .filter() results stay array-shaped (0/1/n matches)", () => {
  test(".filter().map() composes with the array wrap", async () => {
    const e = jsonata<{ items: { active: boolean; name: string }[] }>((c) =>
      c.items.filter((x) => x.active).map((x) => x.name),
    );
    await assertDifferential(e, [
      {
        items: [
          { active: true, name: "brioche" },
          { active: false, name: "rye" },
        ],
      }, // single match
      { items: [{ active: false, name: "rye" }] }, // no match
      {
        items: [
          { active: true, name: "brioche" },
          { active: true, name: "baguette" },
        ],
      },
    ]);
  });
});

describe("m4: comparisons against undefined/null use $exists", () => {
  type C = { x?: string | null };
  const fixtures: C[] = [{}, { x: null }, { x: "cake" }];

  test("x === undefined", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x === undefined),
      fixtures,
    );
  });

  test("x !== undefined", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x !== undefined),
      fixtures,
    );
  });

  test("x == null (loose: true for BOTH null and missing)", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x == null),
      fixtures,
    );
  });

  test("x != null (loose)", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x != null),
      fixtures,
    );
  });

  test("x === null (strict: false for missing)", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x === null),
      fixtures,
    );
  });

  test("x !== null (strict: true for missing)", async () => {
    await assertDifferential(
      jsonata<C>((c) => c.x !== null),
      fixtures,
    );
  });

  test("the literal may appear on EITHER side", async () => {
    await assertDifferential(
      jsonata<C>((c) => undefined === c.x),
      fixtures,
    );
  });
});

describe("optional chaining", () => {
  test("c.a?.b agrees with JSONata's missing-propagation", async () => {
    const e = jsonata<{ owner?: { email: string } }>((c) => c.owner?.email);
    expect(e.jsonata).toBe("owner.email");
    await assertDifferential(e, [{ owner: { email: "baker@bakery.io" } }, {}]);
  });

  test("PLAIN access on a missing parent diverges: the JS oracle throws (documented)", async () => {
    // JSONata propagates missing through `a.b`; strict JS throws a TypeError.
    // The differential harness makes that explicit — authors should write `?.`
    // when a parent may be absent. See expression-support.md.
    const e = jsonata<{ owner?: { email: string } }>((c) => c.owner!.email);
    const r = await differential(e, [{}]);
    expect(r.ok).toBe(false);
    expect(String(r.cases[0]!.expected)).toMatch(/^Error:/); // oracle threw
    expect(r.cases[0]!.actual).toBeUndefined(); // JSONata propagated missing
  });
});

describe("nested .map lambdas", () => {
  test("scalar-reducing inner bodies agree with JS", async () => {
    const e = jsonata<{ orders: { items: { name: string }[] }[] }>((c) =>
      c.orders.map((o) => o.items.map((i) => i.name).join("+")),
    );
    await assertDifferential(e, [
      { orders: [{ items: [{ name: "bun" }, { name: "roll" }] }, { items: [{ name: "loaf" }] }] },
      { orders: [{ items: [{ name: "bun" }] }] }, // singleton outer
      { orders: [] },
    ]);
  });

  test("inner lambda params resolve to the INNER item (scope nesting)", () => {
    expect(t("(c) => c.orders.map(o => o.items.map(i => i.name))")).toBe("[orders.([items.name])]");
  });

  // NOTE: an inner .map that RETURNS an array-per-item ([["a","b"],["c"]])
  // cannot be reproduced — JSONata sequences flatten nested arrays regardless
  // of $map / `.[...]` phrasing (verified against the engine). Documented in
  // expression-support.md; use raw.jsonata + explicit object wrapping if the
  // nested shape matters.
});

describe("element-access lambda bodies", () => {
  test(".map(x => x[0]) projects the first element of each pair", async () => {
    const e = jsonata<{ pairs: string[][] }>((c) => c.pairs.map((p) => p[0]));
    expect(e.jsonata).toBe("[pairs.$[0]]");
    await assertDifferential(e, [
      {
        pairs: [
          ["vanilla", "v"],
          ["chocolate", "c"],
        ],
      },
      { pairs: [["vanilla", "v"]] },
      { pairs: [] },
    ]);
  });
});

describe("object spread → $merge (JS later-wins precedence, engine-proven)", () => {
  test("{ ...a, b: 1, ...c } — later keys WIN on both sides", async () => {
    const e = jsonata<{ a: Record<string, unknown>; c: Record<string, unknown> }>((x) => ({ ...x.a, b: 1, ...x.c }));
    await assertDifferential(e, [
      { a: { b: 0, keep: "a" }, c: { b: 2 } }, // c.b overrides the literal, which overrode a.b
      { a: { x: 1 }, c: { y: 2 } }, // disjoint keys interleave
      { a: {}, c: {} }, // empty spreads → just the literal
    ]);
  });

  test("spread of a MISSING value contributes nothing (JS {...undefined} = {})", async () => {
    const e = jsonata<{ extra?: Record<string, unknown> }>((c) => ({ ...c.extra, b: 1 }));
    await assertDifferential(e, [
      {}, // extra absent: the array constructor drops the missing member before $merge
      { extra: { a: 2 } },
    ]);
  });

  test("spread of a present NULL diverges: JSONata throws, JS yields {} (documented)", async () => {
    const e = jsonata<{ extra: Record<string, unknown> | null }>((c) => ({ ...c.extra, b: 1 }));
    const r = await differential(e, [{ extra: null }]);
    expect(r.ok).toBe(false); // the documented divergence, surfaced loudly
    expect(String(r.cases[0]!.actual)).toMatch(/^Error:/); // engine threw
  });
});

describe("block-bodied lambdas in .map/.filter evaluate per item", () => {
  test(".map with bindings + a guardable ternary agrees with JS", async () => {
    const e = jsonata<{ items: { qty: number; name: string }[] }>((c) =>
      c.items.map((x) => {
        const label = `${x.name}: ${x.qty}`;
        const bulk = x.qty > 10 ? "bulk" : "single";
        return { label, bulk };
      }),
    );
    await assertDifferential(e, [
      {
        items: [
          { qty: 12, name: "scone" },
          { qty: 1, name: "tart" },
        ],
      },
      { items: [{ qty: 3, name: "bun" }] }, // singleton stays array-shaped
      { items: [] },
    ]);
  });

  test(".filter with a block-bodied predicate agrees with JS", async () => {
    const e = jsonata<{ items: { qty: number }[] }>((c) =>
      c.items.filter((x) => {
        const double = x.qty * 2;
        return double > 4;
      }),
    );
    await assertDifferential(e, [{ items: [{ qty: 1 }, { qty: 2 }, { qty: 3 }] }, { items: [{ qty: 0 }] }]);
  });

  test("a DOUBLY nested block lambda (block inside .map inside .map) agrees", async () => {
    const e = jsonata<{ orders: { items: { name: string }[] }[] }>((c) =>
      c.orders.map((o) => {
        const names = o.items.map((i) => i.name).join("+");
        return names;
      }),
    );
    await assertDifferential(e, [
      { orders: [{ items: [{ name: "bun" }, { name: "roll" }] }, { items: [{ name: "loaf" }] }] },
      { orders: [] },
    ]);
  });

  test("an inner binding shadows the outer, and the outer survives (engine-proven)", async () => {
    const e = jsonata<{ base: string; items: { qty: number }[] }>((c) => {
      const y = c.base;
      const mapped = c.items.map((x) => {
        const y = x.qty;
        return y;
      });
      return { keep: y, mapped };
    });
    await assertDifferential(e, [{ base: "cake", items: [{ qty: 1 }, { qty: 2 }] }]);
  });
});

describe(".indexOf evaluates like JS across the edges (engine-proven)", () => {
  test("found / not-found / empty-search / longer-than / empty-receiver all agree", async () => {
    const e = jsonata<{ s: string; sub: string }>((c) => c.s.indexOf(c.sub));
    await assertDifferential(e, [
      { s: "abcdef", sub: "cd" }, // 2
      { s: "abcdef", sub: "a" }, // 0
      { s: "abcdef", sub: "xyz" }, // -1
      { s: "banana", sub: "na" }, // 2 (first occurrence)
      { s: "abc", sub: "" }, // 0
      { s: "", sub: "" }, // 0
      { s: "ab", sub: "abcd" }, // -1
      { s: "", sub: "a" }, // -1
    ]);
  });

  test("a call receiver hoists into a temp yet evaluates identically", async () => {
    const e = jsonata<{ s: string }>((c) => c.s.trim().indexOf("x"));
    expect(e.jsonata).toContain("$__io1"); // the temp actually appears
    await assertDifferential(e, [{ s: "  xyz  " }, { s: " abc " }]);
  });

  test("DIVERGENCE: an astral char before the match makes JS (UTF-16) and the shim (code points) disagree", async () => {
    // Documented in expression-support.md: JS .indexOf counts code UNITS while
    // $length/$substringBefore count code POINTS. A leading astral char is the
    // trigger — captured here so the boundary can't silently move.
    const e = jsonata<{ s: string; sub: string }>((c) => c.s.indexOf(c.sub));
    const r = await differential(e, [{ s: "🎂x", sub: "x" }]); // JS 2, shim 1
    expect(r.ok).toBe(false);
  });
});

describe(".match projects onto the JS array shape (engine-proven)", () => {
  test("full match + groups, no-match null, non-participating optional group", async () => {
    const e = jsonata<{ s: string }>((c) => c.s.match(/(\d+)-(\d+)-(\d+)/));
    await assertDifferential(e, [{ s: "2024-03-15" }, { s: "no date here" }]);

    const opt = jsonata<{ s: string }>((c) => c.s.match(/a(b)?(c)/));
    await assertDifferential(opt, [{ s: "ac" }, { s: "abc" }, { s: "zzz" }]);

    const nogroups = jsonata<{ s: string }>((c) => c.s.match(/cake/));
    await assertDifferential(nogroups, [{ s: "cheesecake" }, { s: "scone" }]);
  });

  test("the i flag passes through and evaluates like JS", async () => {
    const e = jsonata<{ s: string }>((c) => c.s.match(/ABC/i));
    await assertDifferential(e, [{ s: "xxabcyy" }, { s: "nope" }]);
  });
});

describe("strings containing }} survive the round trip", () => {
  test('the emitted JSONata evaluates "a}}b" correctly', async () => {
    const e = jsonata(() => "a}}b");
    await assertDifferential(e, [{}]);
    // The rendered ${{ ... }} form relies on the Scaffolder's Nunjucks lexer
    // respecting string literals when scanning for the `}}` terminator —
    // verified for the real nunjucks engine in ../nunjucks/semantics.test.ts.
    expect(e.toString()).toBe('${{ "a}}b" }}');
  });
});

describe("differential normalize: NaN/Infinity are NOT masked as null", () => {
  test("a JS NaN no longer 'agrees' with a JSONata null", async () => {
    const e = jsonata(() => null);
    (e as any).fn = () => Number.NaN; // a diverging oracle the old JSON round-trip folded to null
    const r = await differential(e, [{}]);
    expect(r.ok).toBe(false);
  });

  test("nested non-finite values are caught too", async () => {
    const e = jsonata(() => ({ v: null }));
    (e as any).fn = () => ({ v: Number.POSITIVE_INFINITY });
    const r = await differential(e, [{}]);
    expect(r.ok).toBe(false);
  });
});
