// The JSONata pretty-printer: exact SHAPE tests per construct, plus proof that
// every formatted rendering still PARSES (validateJsonata) and EVALUATES to the
// same values as the compact canonical form (the differential harness runs the
// pretty `.jsonata` everywhere else in the suite; here the equivalence is
// pinned per shape against the real engine).

import { describe, expect, test } from "bun:test";
import jsonataLib from "jsonata";
import { jsonata } from "../../index.ts";
import { formatJsonata } from "./format.ts";
import { validateJsonata } from "./index.ts";
import { transpileArrowSource } from "./transpile.ts";

/** Compile a SOURCE string and return { compact, pretty } (optimizer-immune). */
function forms(src: string): { compact: string; pretty: string } {
  const compact = transpileArrowSource(src);
  return { compact, pretty: formatJsonata(compact) };
}

/** Assert pretty parses AND evaluates to the same value as compact. */
async function assertEquivalent(compact: string, pretty: string, fixture: unknown): Promise<void> {
  validateJsonata(pretty);
  const a = await jsonataLib(compact).evaluate(fixture as object);
  const b = await jsonataLib(pretty).evaluate(fixture as object);
  expect(b).toEqual(a as never);
}

describe("short expressions stay single-line (no noise)", () => {
  test("a plain || emission is under the threshold", () => {
    // A simple pure left operand inlines — no temp — and stays single-line.
    const { compact, pretty } = forms('(c) => c.name || "unknown"');
    expect(pretty).toBe(compact);
    expect(pretty).toBe('($boolean(name) ? name : "unknown")');
  });

  test("short blocks / paths / objects are untouched", () => {
    expect(formatJsonata("(a or b)")).toBe("(a or b)");
    expect(formatJsonata("($x := a; $x)")).toBe("($x := a; $x)");
    expect(formatJsonata('{"a": 1, "b": 2}')).toBe('{"a": 1, "b": 2}');
  });
});

describe("block expressions: statement per line, closing paren aligned", () => {
  test("an || chain block formats with nested short blocks inline", async () => {
    // The inner `.join(",")` left operand is a CALL, so both || levels keep
    // their temps — the block-with-nested-short-block shape under test.
    const { compact, pretty } = forms('(c) => c.tags.join(",") || c.b || c.c');
    expect(pretty).toBe(
      "(\n" +
        '  $__or2 := ($__or1 := $join(tags, ","); $boolean($__or1) ? $__or1 : b);\n' +
        "  $boolean($__or2) ? $__or2 : c\n" +
        ")",
    );
    await assertEquivalent(compact, pretty, { tags: [], b: "middle" });
  });

  test("the .length shim formats block + inner ternary", async () => {
    // A CALL receiver keeps the temp, so the block + inner-ternary shape stands.
    const { compact, pretty } = forms("(c) => c.tags.concat(c.more).length");
    expect(pretty).toBe(
      "(\n" +
        "  $__len1 := $append(tags, more);\n" +
        '  $type($__len1) = "string"\n' +
        "    ? $length($__len1)\n" +
        "    : $count($__len1)\n" +
        ")",
    );
    await assertEquivalent(compact, pretty, { tags: [1, 2], more: [3] });
  });

  test("a simple-receiver .length inlines to a temp-free ternary", async () => {
    // No `$__len` temp — the receiver is repeated inline. The compact form is a
    // single line; the pretty-printer still splits the long ternary per branch.
    const { compact, pretty } = forms("(c) => c.members.length");
    expect(compact).toBe('($type(members) = "string" ? $length(members) : $count(members))');
    expect(pretty).toBe('($type(members) = "string"\n' + "  ? $length(members)\n" + "  : $count(members))");
    await assertEquivalent(compact, pretty, { members: [1, 2, 3] });
    await assertEquivalent(compact, pretty, { members: "brioche" });
  });
});

describe("ternaries: branches on their own lines past the threshold", () => {
  test("a long parenthesized ternary chain indents per level", async () => {
    const { compact, pretty } = forms(
      '(c) => c.size === "6 inch" ? 20 : c.size === "Sheet" ? 60 : c.size === "Cupcake" ? 5 : 0',
    );
    // The outer ternary splits; the else-chain is under the threshold and
    // stays single-line (short expressions never add noise).
    expect(pretty).toBe(
      '((size = "6 inch")\n' + "  ? 20\n" + '  : ((size = "Sheet") ? 60 : ((size = "Cupcake") ? 5 : 0)))',
    );
    for (const size of ["6 inch", "Sheet", "Cupcake", "other"]) {
      await assertEquivalent(compact, pretty, { size });
    }
  });
});

describe("long object / array constructors: member per line", () => {
  test("object members split; keys stay inline with their values", async () => {
    const { compact, pretty } = forms(
      '(c) => ({ summary: `New order: ${c.cakeName}`, project: { key: "BAKERY" }, labels: c.tags })',
    );
    expect(pretty).toBe(
      "{\n" +
        '  "summary": ("New order: " & (cakeName)),\n' +
        '  "project": {"key": "BAKERY"},\n' +
        '  "labels": tags\n' +
        "}",
    );
    await assertEquivalent(compact, pretty, { cakeName: "Madeira", tags: ["rush"] });
  });

  test("long array literals split element per line", async () => {
    const { compact, pretty } = forms('(c) => [{ label: "Base", amount: c.base }, { label: "Delivery", amount: 4 }]');
    expect(pretty).toBe(
      "[\n" + '  {"label": "Base", "amount": base},\n' + '  {"label": "Delivery", "amount": 4}\n' + "]",
    );
    await assertEquivalent(compact, pretty, { base: 35 });
  });
});

describe("scanner safety: strings and regex literals are opaque", () => {
  test('a string containing "; ? :" never splits', () => {
    const s = '($x := "; ? : fake"; $x)';
    expect(formatJsonata(s)).toBe(s);
  });

  test("the parseInt shim (regex literal) formats and still evaluates", async () => {
    // biome-ignore lint/correctness/useParseIntRadix: the radix-less form is the transpiler INPUT under test
    const e = jsonata<{ s: string }>((c) => parseInt(c.s));
    expect(e.jsonata).toBe(
      "(\n" +
        "  $__pi1 := $match(s, /^\\s*([-+]?)([0-9]+)/);\n" +
        '  $exists($__pi1) ? ($__pi2 := $number($__pi1.groups[1]); $__pi1.groups[0] = "-" ? -$__pi2 : $__pi2)\n' +
        ")",
    );
    await assertEquivalent(e.compact, e.jsonata, { s: " -42px" });
  });
});

describe("the JsonataExpr carries both renderings", () => {
  test(".jsonata is pretty, .compact canonical; both validate", () => {
    const e = jsonata<{ members: string[] }>((c) => c.members.length);
    expect(e.compact.includes("\n")).toBe(false);
    expect(e.jsonata.includes("\n")).toBe(true);
    expect(() => validateJsonata(e.jsonata)).not.toThrow();
    expect(() => validateJsonata(e.compact)).not.toThrow();
  });

  test("short expressions have identical pretty and compact forms", () => {
    const e = jsonata<{ a: string }>((c) => c.a);
    expect(e.jsonata).toBe(e.compact);
  });

  test("render() always emits the pretty form", () => {
    const e = jsonata<{ members: string[] }>((c) => c.members.length);
    expect(e.render({ env: "test" })).toBe(`\${{ ${e.jsonata} }}`);
  });

  test("raw.jsonata is NEVER reformatted (hand-written formatting preserved)", () => {
    const r = jsonata.raw`( $x := $sum(parameters.amounts);      $x    )`;
    expect(r.jsonata).toBe("( $x := $sum(parameters.amounts);      $x    )");
    expect(r.compact).toBe(r.jsonata);
  });
});
