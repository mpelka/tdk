// Focused unit tests: assert the EXACT JSONata string emitted for each
// whitelisted construct, plus that unsupported constructs throw clearly.

import { describe, expect, test } from "bun:test";
import { jsonata, TranspileError } from "../../index.ts";

/** Compile an arrow and return the emitted JSONata string (COMPACT canonical
 * form — the pretty rendering is covered by format.test.ts). */
function js(fn: (c: any) => unknown): string {
  return jsonata(fn).compact;
}

describe("literals", () => {
  test("string literal is quoted + escaped", () => {
    expect(js(() => 'hi "there"\n')).toBe('"hi \\"there\\"\\n"');
  });
  test("number / boolean / null pass through", () => {
    expect(js(() => 42)).toBe("42");
    expect(js(() => true)).toBe("true");
    expect(js(() => false)).toBe("false");
    expect(js(() => null)).toBe("null");
  });
});

describe("member + element access", () => {
  test("context param is stripped to the root path", () => {
    expect(js((c) => c.parameters.cakeName)).toBe("parameters.cakeName");
  });
  test("nested member access flattens to a path", () => {
    expect(js((c) => c.a.b.c)).toBe("a.b.c");
  });
  test("element access by string key → path step", () => {
    // biome-ignore lint/complexity/useLiteralKeys: the bracket string-key access is the transpiler INPUT under test
    expect(js((c) => c.obj["key"])).toBe("obj.key");
  });
  test("element access by numeric index → bracket index", () => {
    expect(js((c) => c.list[0])).toBe("list[0]");
  });
});

describe("object + array literals", () => {
  test("object literal → JSONata object constructor with quoted keys", () => {
    expect(js((c) => ({ key: "BAKERY", repo: c.parameters.cakeName }))).toBe(
      '{"key": "BAKERY", "repo": parameters.cakeName}',
    );
  });
  test("string-literal object key is preserved", () => {
    expect(js(() => ({ "a-b": 1 }))).toBe('{"a-b": 1}');
  });
  test("array literal", () => {
    expect(js((c) => [1, "x", c.p])).toBe('[1, "x", p]');
  });
  test("nested object", () => {
    expect(js(() => ({ project: { key: "BAKERY" } }))).toBe('{"project": {"key": "BAKERY"}}');
  });
});

describe("binary operators", () => {
  test("=== / == → =", () => {
    expect(js((c) => c.a === c.b)).toBe("(a = b)");
    // biome-ignore lint/suspicious/noDoubleEquals: intentional — verifies `==` also transpiles to JSONata `=`
    expect(js((c) => c.a == c.b)).toBe("(a = b)");
  });
  test("!== / != → !=", () => {
    expect(js((c) => c.a !== c.b)).toBe("(a != b)");
  });
  test("comparisons pass through", () => {
    expect(js((c) => c.a < c.b)).toBe("(a < b)");
    expect(js((c) => c.a >= c.b)).toBe("(a >= b)");
  });
  test("&& / || emit value-preserving conditionals (not boolean and/or)", () => {
    // JSONata `and`/`or` return BOOLEANS — `(name or "unknown")` would emit
    // `true`. The $boolean conditional keeps the JS selection semantics. A SIMPLE
    // pure left operand (a path here) is INLINED — no temp, since repeating a
    // pure lookup is provably identical.
    expect(js((c) => c.a && c.b)).toBe("($boolean(a) ? b : a)");
    expect(js((c) => c.a || c.b)).toBe("($boolean(a) ? a : b)");
  });
  test("&& / || keep a temp when the left operand is NOT simple (a call)", () => {
    // A call is nondeterministic/costly in general, so the temp stays to
    // evaluate it exactly once — the value that guards against double-eval.
    expect(js((c) => c.tags.join() || c.b)).toBe('($__or1 := $join(tags, ","); $boolean($__or1) ? $__or1 : b)');
    expect(js((c) => c.tags.join() && c.b)).toBe('($__and1 := $join(tags, ","); $boolean($__and1) ? b : $__and1)');
  });
  test("|| chains nest left-associatively; the outer left is a conditional (kept)", () => {
    // The inner `a || b` inlines (both simple); the OUTER left operand is then a
    // conditional — NOT simple — so it correctly keeps its temp.
    expect(js((c) => c.a || c.b || c.c)).toBe("($__or1 := ($boolean(a) ? a : b); $boolean($__or1) ? $__or1 : c)");
  });
  test("arithmetic - * / % pass through", () => {
    expect(js((c) => c.a - c.b)).toBe("(a - b)");
    expect(js((c) => c.a * c.b)).toBe("(a * b)");
    expect(js((c) => c.a / c.b)).toBe("(a / b)");
    expect(js((c) => c.a % c.b)).toBe("(a % b)");
  });
  test("+ with a string operand → concat &", () => {
    // biome-ignore lint/style/useTemplate: the `+` with a string operand is the transpiler INPUT under test (it transpiles to `&`)
    expect(js((c) => c.a + "x")).toBe('(a & "x")');
    // biome-ignore lint/style/useTemplate: the `+` with a string operand is the transpiler INPUT under test (it transpiles to `&`)
    expect(js((c) => "x" + c.a)).toBe('("x" & a)');
  });
  test("+ with numeric operands → +", () => {
    expect(js((c) => c.a + c.b)).toBe("(a + b)");
    expect(js((c) => c.a + 1)).toBe("(a + 1)");
  });
});

describe("unary", () => {
  test("!x → $not(x)", () => {
    expect(js((c) => !c.flag)).toBe("$not(flag)");
  });
  test("-x → -x", () => {
    expect(js((c) => -c.n)).toBe("-n");
  });
});

describe("ternary", () => {
  test("c ? a : b", () => {
    expect(js((c) => (c.cond ? "yes" : "no"))).toBe('(cond ? "yes" : "no")');
  });
});

describe("template literals", () => {
  test('`a${x}b` → "a" & (x) & "b"', () => {
    expect(js((c) => `New order: ${c.parameters.cakeName}`)).toBe('("New order: " & (parameters.cakeName))');
  });
  test("interpolation between two literals", () => {
    expect(js((c) => `a${c.x}b`)).toBe('("a" & (x) & "b")');
  });
});

describe("array methods", () => {
  test(".filter(x => pred) → [arr[$boolean(pred)]] (truthiness + array-wrapped)", () => {
    // $boolean: a numeric predicate would otherwise be an INDEX lookup; the
    // [ ... ] wrap keeps 0/1-match results array-shaped like JS .filter().
    expect(js((c) => c.items.filter((x: any) => x.active))).toBe("[items[$boolean(active)]]");
  });
  test(".map(x => x.field) → [arr.field] (array-context wrapped)", () => {
    expect(js((c) => c.members.map((m: any) => m.email))).toBe("[members.email]");
  });
  test(".map(x => ({...})) → [arr.({...})]", () => {
    expect(js((c) => c.members.map((m: any) => ({ e: m.email })))).toBe('[members.({"e": email})]');
  });
  test(".join(sep) → $join(arr, sep)", () => {
    expect(js((c) => c.tags.join(", "))).toBe('$join(tags, ", ")');
  });
  test(".length → type-dispatching $length/$count shim (inlined for a simple receiver)", () => {
    // $count(str) is 1 for ANY string, so `.length` dispatches on $type to be
    // exact for both strings and arrays. A SIMPLE pure receiver (a path here) is
    // repeated inline — no temp.
    expect(js((c) => c.members.length)).toBe('($type(members) = "string" ? $length(members) : $count(members))');
  });
  test(".length keeps a temp when the receiver is NOT simple (a call)", () => {
    // A call receiver is stashed in a temp so the shim evaluates it exactly once.
    expect(js((c) => c.tags.concat(c.more).length)).toBe(
      '($__len1 := $append(tags, more); $type($__len1) = "string" ? $length($__len1) : $count($__len1))',
    );
  });
  test(".map().join() composes", () => {
    expect(js((c) => c.members.map((m: any) => m.email).join(", "))).toBe('$join([members.email], ", ")');
  });
});

describe("function map (methods)", () => {
  test(".toUpperCase()", () => {
    expect(js((c) => c.s.toUpperCase())).toBe("$uppercase(s)");
  });
  test(".toLowerCase()", () => {
    expect(js((c) => c.s.toLowerCase())).toBe("$lowercase(s)");
  });
  test(".trim()", () => {
    expect(js((c) => c.s.trim())).toBe("$trim(s)");
  });
  test(".substring(a, b)", () => {
    expect(js((c) => c.s.substring(0, 3))).toBe("$substring(s, 0, 3)");
  });
  test(".includes(x) → $contains", () => {
    expect(js((c) => c.s.includes("z"))).toBe('$contains(s, "z")');
  });
  test(".split(x)", () => {
    expect(js((c) => c.s.split(","))).toBe('$split(s, ",")');
  });
  test(".replace(a, b) → $replace limited to the FIRST occurrence", () => {
    expect(js((c) => c.s.replace("a", "b"))).toBe('$replace(s, "a", "b", 1)');
  });
  test(".replaceAll(a, b) → unlimited $replace", () => {
    expect(js((c) => c.s.replaceAll("a", "b"))).toBe('$replace(s, "a", "b")');
  });
});

describe("function map (globals)", () => {
  test("String(x)", () => {
    expect(js((c) => String(c.n))).toBe("$string(n)");
  });
  test("Number(x)", () => {
    expect(js((c) => Number(c.s))).toBe("$number(s)");
  });
  test("Boolean(x)", () => {
    expect(js((c) => Boolean(c.x))).toBe("$boolean(x)");
  });
  test("Math.round/floor/ceil/abs", () => {
    expect(js((c) => Math.round(c.n))).toBe("$round(n)");
    expect(js((c) => Math.floor(c.n))).toBe("$floor(n)");
    expect(js((c) => Math.ceil(c.n))).toBe("$ceil(n)");
    expect(js((c) => Math.abs(c.n))).toBe("$abs(n)");
  });
});

describe(".charAt / .startsWith / .endsWith", () => {
  test(".charAt(i) → $substring(s, i, 1)", () => {
    expect(js((c) => c.s.charAt(1))).toBe("$substring(s, 1, 1)");
    expect(js((c) => c.s.charAt(0))).toBe("$substring(s, 0, 1)");
  });
  test(".charAt with a computed index passes it through (a plain function arg)", () => {
    expect(js((c) => c.s.charAt(c.i))).toBe("$substring(s, i, 1)");
  });
  test(".charAt(-1) is rejected ($substring selects from the END there)", () => {
    expect(() => js((c) => c.s.charAt(-1))).toThrow(/charAt\(-1\).*END/s);
  });
  test(".charAt(1.5) is rejected (JS truncates, $substring does not)", () => {
    expect(() => js((c) => c.s.charAt(1.5))).toThrow(/integer literal index/);
  });
  test(".startsWith(literal) → prefix $substring comparison", () => {
    expect(js((c) => c.s.startsWith("cake"))).toBe('($substring(s, 0, 4) = "cake")');
  });
  test(".startsWith length counts CODE POINTS (astral-safe)", () => {
    expect(js((c) => c.s.startsWith("🎂"))).toBe('($substring(s, 0, 1) = "🎂")');
  });
  test(".endsWith(literal) → suffix $substring comparison", () => {
    expect(js((c) => c.s.endsWith("cake"))).toBe('($substring(s, -4) = "cake")');
  });
  test('.endsWith("") folds to true ($substring(s, -0) returns the WHOLE string)', () => {
    expect(js((c) => c.s.endsWith(""))).toBe("true");
  });
  test("computed search strings hoist into a temp (endsWith gets the empty guard)", () => {
    expect(js((c) => c.s.startsWith(c.pre))).toBe("($__sw1 := pre; $substring(s, 0, $length($__sw1)) = $__sw1)");
    expect(js((c) => c.s.endsWith(c.suf))).toBe(
      '($__ew1 := suf; $__ew1 = "" or $substring(s, -$length($__ew1)) = $__ew1)',
    );
  });
  test("the JS position/endPosition second argument is rejected", () => {
    expect(() => js((c) => c.s.startsWith("a", 2))).toThrow(/position second argument is not supported/);
    expect(() => js((c) => c.s.endsWith("a", 2))).toThrow(/endPosition second argument is not supported/);
  });
});

describe(".indexOf / .match", () => {
  test(".indexOf(literal) inlines (simple receiver + literal search, no temp)", () => {
    expect(js((c) => c.s.indexOf("cake"))).toBe('($contains(s, "cake") ? $length($substringBefore(s, "cake")) : -1)');
  });
  test(".indexOf with a path receiver + path search inlines both (no temp)", () => {
    expect(js((c) => c.s.indexOf(c.sub))).toBe("($contains(s, sub) ? $length($substringBefore(s, sub)) : -1)");
  });
  test(".indexOf hoists a CALL receiver into a temp (evaluated once)", () => {
    expect(js((c) => c.s.trim().indexOf("x"))).toBe(
      '($__io1 := $trim(s); $contains($__io1, "x") ? $length($substringBefore($__io1, "x")) : -1)',
    );
  });
  test(".indexOf's fromIndex second argument is rejected", () => {
    expect(() => js((c) => c.s.indexOf("x", 2))).toThrow(/fromIndex second argument is not supported/);
  });
  test(".match(/re/) projects $match onto the JS array shape (null on no match)", () => {
    expect(js((c) => c.s.match(/(\d+)-(\d+)/))).toBe(
      "($__m1 := $match(s, /(\\d+)-(\\d+)/)[0]; $exists($__m1) ? $append([$__m1.match], $__m1.groups) : null)",
    );
  });
  test(".match passes the i/m flags through", () => {
    expect(js((c) => c.s.match(/abc/i))).toBe(
      "($__m1 := $match(s, /abc/i)[0]; $exists($__m1) ? $append([$__m1.match], $__m1.groups) : null)",
    );
  });
  test(".match(/re/g) is rejected (JS returns full-match strings, a different shape)", () => {
    expect(() => js((c) => c.s.match(/\d/g))).toThrow(/global flag|not supported/);
  });
  test(".match with an unsupported flag (s/u/y) is rejected", () => {
    expect(() => js((c) => c.s.match(/a.c/s))).toThrow(/JSONata's regex grammar does not accept/);
  });
  test(".match with a string (non-literal) pattern is rejected", () => {
    expect(() => js((c) => c.s.match("abc"))).toThrow(/REGEX LITERAL argument/);
  });
});

describe("object spread → $merge", () => {
  test("{ ...a, b: 1, ...c } preserves interleaving order", () => {
    expect(js((c) => ({ ...c.a, b: 1, ...c.c }))).toBe('$merge([a, {"b": 1}, c])');
  });
  test("consecutive plain props group into ONE object segment", () => {
    expect(js((c) => ({ ...c.a, x: 1, y: 2 }))).toBe('$merge([a, {"x": 1, "y": 2}])');
  });
  test("a lone spread still merges (spread of missing → {} like JS)", () => {
    expect(js((c) => ({ ...c.a }))).toBe("$merge([a])");
  });
  test("an object without spreads stays a plain constructor", () => {
    expect(js((c) => ({ a: c.x }))).toBe('{"a": x}');
  });
});

describe("parseInt / parseFloat lenient shims", () => {
  test("parseInt(s) emits the $match-extract-then-$number shim", () => {
    // biome-ignore lint/correctness/useParseIntRadix: the radix-less form is the transpiler INPUT under test — the shim always parses base 10 and REJECTS a radix argument
    expect(js((c) => parseInt(c.s))).toBe(
      "($__pi1 := $match(s, /^\\s*([-+]?)([0-9]+)/); " +
        '$exists($__pi1) ? ($__pi2 := $number($__pi1.groups[1]); $__pi1.groups[0] = "-" ? -$__pi2 : $__pi2))',
    );
  });
  test("parseFloat(s) emits the fraction/exponent-aware shim", () => {
    expect(js((c) => parseFloat(c.s))).toBe(
      "($__pf1 := $match(s, /^\\s*([-+]?)([0-9]+(\\.[0-9]+)?|\\.[0-9]+)([eE][-+]?[0-9]+)?/); " +
        '$exists($__pf1) ? ($__pf2 := $__pf1.groups[1] & ($exists($__pf1.groups[3]) ? $__pf1.groups[3] : ""); ' +
        '$__pf3 := $number($substring($__pf2, 0, 1) = "." ? "0" & $__pf2 : $__pf2); ' +
        '$__pf1.groups[0] = "-" ? -$__pf3 : $__pf3))',
    );
  });
});

describe("unsupported constructs throw a clear, located error", () => {
  test("external (non-literal) variable reference is rejected", () => {
    // NOTE: Bun's `fn.toString()` constant-FOLDS captured primitives
    // (`const n = 5; () => n` becomes `() => 5`), so those escape detection but
    // fold to the correct literal. A captured OBJECT/array survives as an
    // identifier and IS caught — that's the dangerous case.
    const cfg = { region: "eu" };
    expect(() => js(() => cfg.region)).toThrow(TranspileError);
    expect(() => js(() => cfg.region)).toThrow(/external variables|Unknown reference/);
  });
  test("unsupported method names point at the escape hatch", () => {
    expect(() => js((c) => c.s.repeat(3))).toThrow(/raw\.jsonata/);
  });
  test("unsupported global call", () => {
    expect(() => js((c) => encodeURIComponent(c.s))).toThrow(/Unsupported function call/);
  });
  test("parseInt's radix argument is rejected with a pointed error", () => {
    expect(() => js((c) => parseInt(c.s, 10))).toThrow(/radix argument is not supported/);
  });
  test("a block-bodied arrow with no return is rejected", () => {
    // Block bodies ARE supported now (see the statement-layer tests), but a
    // block that never returns a value has nothing to emit as its result.
    expect(() =>
      js((c) => {
        c.x;
      }),
    ).toThrow(/must end with/);
  });
  test("bitwise / unsupported operator is rejected", () => {
    expect(() => js((c) => c.a & c.b)).toThrow(/Unsupported binary operator/);
  });
  test("error message includes the raw.jsonata hint", () => {
    try {
      js((c) => c.s.repeat(3));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("raw.jsonata");
    }
  });
});
