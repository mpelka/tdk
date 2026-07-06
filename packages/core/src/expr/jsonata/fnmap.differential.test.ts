// MECHANICAL engine-verification of the function map: every METHOD_MAP and
// GLOBAL_MAP row must carry at least one differential case here (TS oracle vs
// the real JSONata engine), so no row can exist with unverified semantics —
// adding a row without a case FAILS the completeness test. Rows whose
// semantics cannot be exercised this way must be SKIPPED EXPLICITLY with a
// reason, never silently.
//
// Fixtures stay inside each mapping's agreeing domain; the documented
// divergences at the edges (Number("") throws, $boolean([]) is false,
// String(object) shapes differ, Math.round's half-to-even, $join on
// non-string arrays) live in docs/expression-support.md.

import { describe, expect, test } from "bun:test";
import { assert, assertDifferential, jsonata, substringAfter, substringBefore } from "../../index.ts";
import type { DifferentialOptions } from "./differential.ts";
import { GLOBAL_MAP, METHOD_MAP, SPECIAL_GLOBAL_FORMS, SPECIAL_METHOD_FORMS } from "./fnmap.ts";
import type { JsonataExpr } from "./index.ts";

interface RowCase {
  /** The compiled expression whose oracle doubles as the reference. */
  expr: JsonataExpr<any, unknown>;
  fixtures: unknown[];
  /** Per-case harness options (e.g. the documented parseInt/parseFloat NaN↔missing agreement). */
  opts?: DifferentialOptions;
}
type Row = { cases: RowCase[] } | { skip: string };

const METHOD_ROWS: Record<string, Row> = {
  join: {
    cases: [
      {
        expr: jsonata<any>((c) => c.tags.join(", ")),
        fixtures: [{ tags: ["rye", "spelt", "wheat"] }, { tags: ["solo"] }],
      },
      { expr: jsonata<any>((c) => c.tags.join()), fixtures: [{ tags: ["rye", "spelt"] }] },
    ],
  },
  toUpperCase: {
    cases: [
      { expr: jsonata<any>((c) => c.s.toUpperCase()), fixtures: [{ s: "brioche" }, { s: "MiXeD 42" }, { s: "" }] },
    ],
  },
  toLowerCase: {
    cases: [{ expr: jsonata<any>((c) => c.s.toLowerCase()), fixtures: [{ s: "BRIOCHE" }, { s: "MiXeD 42" }] }],
  },
  trim: {
    cases: [{ expr: jsonata<any>((c) => c.s.trim()), fixtures: [{ s: "  eclair  " }, { s: "no-pad" }] }],
  },
  includes: {
    cases: [
      { expr: jsonata<any>((c) => c.s.includes("cake")), fixtures: [{ s: "cheesecake" }, { s: "scone" }, { s: "" }] },
    ],
  },
  concat: {
    cases: [
      {
        expr: jsonata<any>((c) => c.a.concat(c.b)),
        fixtures: [
          { a: ["rye"], b: ["spelt", "oat"] },
          { a: ["rye", "oat"], b: ["spelt"] },
        ],
      },
    ],
  },
  split: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.split(",")),
        fixtures: [{ s: "rye,spelt,oat" }, { s: "single" }],
      },
    ],
  },
  replace: {
    cases: [
      { expr: jsonata<any>((c) => c.s.replace("a", "o")), fixtures: [{ s: "banana" }, { s: "none" }, { s: "" }] },
    ],
  },
  replaceAll: {
    cases: [{ expr: jsonata<any>((c) => c.s.replaceAll("a", "o")), fixtures: [{ s: "banana" }, { s: "none" }] }],
  },
  padStart: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.padStart(5, "0")),
        fixtures: [{ s: "7" }, { s: "12345" }, { s: "123456" }, { s: "" }],
      },
    ],
  },
  padEnd: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.padEnd(5, "0")),
        fixtures: [{ s: "7" }, { s: "12345" }, { s: "123456" }, { s: "" }],
      },
    ],
  },
};

const GLOBAL_ROWS: Record<string, Row> = {
  assert: {
    cases: [
      {
        expr: jsonata<any>((c) => {
          assert(c.qty > 0, "the order needs at least one cake");
          return c.qty;
        }),
        fixtures: [{ qty: 3 }, { qty: 0 }], // passing AND throwing (throw-for-throw agreement)
      },
    ],
  },
  substringAfter: {
    cases: [
      {
        expr: jsonata<any>((c) => substringAfter(c.ref, "user:default/")),
        fixtures: [{ ref: "user:default/baker" }, { ref: "no-prefix" }, { ref: "user:default/" }],
      },
    ],
  },
  substringBefore: {
    cases: [
      {
        expr: jsonata<any>((c) => substringBefore(c.s, "@")),
        fixtures: [{ s: "baker@bakery.io" }, { s: "no-at" }],
      },
    ],
  },
  String: {
    // NOTE: String(object) diverges ($string emits JSON, JS "[object Object]") — documented.
    cases: [{ expr: jsonata<any>((c) => String(c.n)), fixtures: [{ n: 42 }, { n: true }, { n: "already" }] }],
  },
  Number: {
    // NOTE: Number("") diverges ($number throws, JS yields 0) — documented.
    cases: [{ expr: jsonata<any>((c) => Number(c.s)), fixtures: [{ s: "42" }, { s: "3.5" }, { s: "-7" }] }],
  },
  Boolean: {
    // NOTE: Boolean([]) / Boolean([0]) diverge ($boolean is false, JS true) — documented.
    cases: [
      { expr: jsonata<any>((c) => Boolean(c.x)), fixtures: [{ x: "yes" }, { x: "" }, { x: 0 }, { x: 5 }, { x: true }] },
    ],
  },
  "Math.round": {
    // NOTE: exact halves diverge ($round is half-to-even, JS rounds half up) — documented.
    cases: [{ expr: jsonata<any>((c) => Math.round(c.n)), fixtures: [{ n: 2.3 }, { n: 2.7 }, { n: -1.2 }, { n: 4 }] }],
  },
  "Math.floor": {
    cases: [{ expr: jsonata<any>((c) => Math.floor(c.n)), fixtures: [{ n: 2.7 }, { n: -1.2 }, { n: 4 }] }],
  },
  "Math.ceil": {
    cases: [{ expr: jsonata<any>((c) => Math.ceil(c.n)), fixtures: [{ n: 2.1 }, { n: -1.8 }, { n: 4 }] }],
  },
  "Math.abs": {
    cases: [{ expr: jsonata<any>((c) => Math.abs(c.n)), fixtures: [{ n: -3 }, { n: 3 }, { n: 0 }] }],
  },
};

// SPECIAL-cased emissions (transpile.ts owns their argument transforms — see
// SPECIAL_*_FORMS in fnmap.ts). Same contract as the map rows: every special
// form must carry at least one engine-verified case here. The fixtures pin the
// JS edges each shim explicitly closes (charAt past-the-end, startsWith/endsWith
// empty-sub / longer-than / exact-length, parseInt/parseFloat leniency).
const SPECIAL_ROWS: Record<string, Row> = {
  slice: {
    cases: [
      { expr: jsonata<any>((c) => c.s.slice(2)), fixtures: [{ s: "chocolate" }, { s: "ab" }, { s: "" }] },
      { expr: jsonata<any>((c) => c.s.slice(1, 4)), fixtures: [{ s: "chocolate" }, { s: "ab" }] },
    ],
  },
  substring: {
    cases: [
      { expr: jsonata<any>((c) => c.s.substring(1, 4)), fixtures: [{ s: "chocolate" }, { s: "ab" }, { s: "" }] },
      { expr: jsonata<any>((c) => c.s.substring(4, 1)), fixtures: [{ s: "chocolate" }] }, // JS swaps
    ],
  },
  charAt: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.charAt(1)),
        fixtures: [{ s: "brioche" }, { s: "b" }, { s: "" }], // middle / past-end / empty
      },
      { expr: jsonata<any>((c) => c.s.charAt(0)), fixtures: [{ s: "brioche" }, { s: "" }] },
      { expr: jsonata<any>((c) => c.s.charAt(5)), fixtures: [{ s: "abc" }] }, // past-end → "" on both sides
      {
        expr: jsonata<any>((c) => c.s.charAt(c.i)),
        fixtures: [
          { s: "brioche", i: 3 },
          { s: "ab", i: 9 },
        ],
      },
    ],
  },
  startsWith: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.startsWith("cake")),
        fixtures: [{ s: "cakewalk" }, { s: "cupcake" }, { s: "cake" }, { s: "ca" }, { s: "" }],
        // exact-length ("cake") and sub-longer-than-s ("ca", "") included
      },
      {
        expr: jsonata<any>((c) => c.s.startsWith("")),
        fixtures: [{ s: "brioche" }, { s: "" }], // JS: always true
      },
      {
        expr: jsonata<any>((c) => c.s.startsWith(c.pre)),
        fixtures: [
          { s: "cakewalk", pre: "cake" },
          { s: "cakewalk", pre: "walk" },
          { s: "cakewalk", pre: "" },
          { s: "ca", pre: "cake" },
        ],
      },
    ],
  },
  endsWith: {
    cases: [
      {
        expr: jsonata<any>((c) => c.s.endsWith("cake")),
        fixtures: [{ s: "cheesecake" }, { s: "cakewalk" }, { s: "cake" }, { s: "ke" }, { s: "" }],
      },
      {
        expr: jsonata<any>((c) => c.s.endsWith("")),
        fixtures: [{ s: "brioche" }, { s: "" }], // JS: always true (compile-time fold)
      },
      {
        expr: jsonata<any>((c) => c.s.endsWith(c.suf)),
        fixtures: [
          { s: "cheesecake", suf: "cake" },
          { s: "cheesecake", suf: "cheese" },
          { s: "cheesecake", suf: "" }, // the runtime `= ""` guard
          { s: "ke", suf: "cake" },
        ],
      },
    ],
  },
  indexOf: {
    cases: [
      {
        // Every JS edge the shim closes: found-in-the-middle, found-at-0,
        // not-found (→ -1), search longer than receiver (→ -1), empty search
        // ("abc".indexOf("") = 0, "".indexOf("") = 0), and an empty receiver.
        expr: jsonata<any>((c) => c.s.indexOf(c.sub)),
        fixtures: [
          { s: "abcdef", sub: "cd" }, // middle → 2
          { s: "abcdef", sub: "a" }, // start → 0
          { s: "abcdef", sub: "xyz" }, // not found → -1
          { s: "banana", sub: "na" }, // first occurrence → 2
          { s: "abc", sub: "" }, // empty search → 0
          { s: "", sub: "" }, // empty receiver + empty search → 0
          { s: "ab", sub: "abcd" }, // search longer than receiver → -1
          { s: "", sub: "a" }, // empty receiver → -1
        ],
      },
      // A literal search string exercises the inline path (no temp).
      {
        expr: jsonata<any>((c) => c.s.indexOf("cake")),
        fixtures: [{ s: "cheesecake" }, { s: "cakewalk" }, { s: "scone" }, { s: "" }],
      },
    ],
  },
  match: {
    cases: [
      {
        // Projection to the JS RegExpMatchArray shape: full match + capture
        // groups, engine-verified value-equivalent for realistic patterns.
        expr: jsonata<any>((c) => c.s.match(/(\d+)-(\d+)-(\d+)/)),
        fixtures: [
          { s: "2024-03-15" }, // full + three groups
          { s: "no date here" }, // no match → null on both sides
        ],
      },
      // Zero capture groups → a one-element array; a match not at the start.
      { expr: jsonata<any>((c) => c.s.match(/cake/)), fixtures: [{ s: "cheesecake" }, { s: "scone" }] },
      // A NON-participating optional group → null in the slot on both sides.
      {
        expr: jsonata<any>((c) => c.s.match(/a(b)?(c)/)),
        fixtures: [{ s: "ac" }, { s: "abc" }, { s: "xyz" }],
      },
      // The case-insensitive flag passes through (JSONata accepts i and m).
      { expr: jsonata<any>((c) => c.s.match(/ABC/i)), fixtures: [{ s: "xxabcyy" }, { s: "nope" }] },
    ],
  },
  parseInt: {
    cases: [
      {
        // biome-ignore lint/correctness/useParseIntRadix: the radix-less form is the transpiler INPUT under test — the shim always parses base 10 and REJECTS a radix argument
        expr: jsonata<any>((c) => parseInt(c.s)),
        // NaN↔missing is the DOCUMENTED agreement for the no-parse fixtures.
        opts: { nanIsMissing: true },
        fixtures: [
          { s: "42" },
          { s: " 42 " }, // surrounding whitespace OK
          { s: "3.7px" }, // lenient: stops at the first non-digit → 3
          { s: "-8px" },
          { s: "+7" },
          { s: "px" }, // JS NaN ↔ shim missing
          { s: "" },
        ],
      },
    ],
  },
  parseFloat: {
    cases: [
      {
        expr: jsonata<any>((c) => parseFloat(c.s)),
        opts: { nanIsMissing: true },
        fixtures: [
          { s: "3.5" },
          { s: "3.7px" },
          { s: ".5" }, // leading-dot magnitude → "0"-prefixed for $number
          { s: "-.5" },
          { s: "+2.5" },
          { s: "1e3x" }, // exponent kept, trailing garbage dropped
          { s: "3." }, // JS 3 — the regex stops before the bare dot
          { s: " 2.5 " },
          { s: "px" }, // JS NaN ↔ shim missing
        ],
      },
    ],
  },
};

describe("fnmap completeness — every row has an engine-verified case", () => {
  test("METHOD_MAP rows all covered (and no stale cases)", () => {
    expect(Object.keys(METHOD_ROWS).sort()).toEqual(Object.keys(METHOD_MAP).sort());
  });

  test("GLOBAL_MAP rows all covered (and no stale cases)", () => {
    expect(Object.keys(GLOBAL_ROWS).sort()).toEqual(Object.keys(GLOBAL_MAP).sort());
  });

  test("SPECIAL forms all covered (and no stale cases)", () => {
    expect(Object.keys(SPECIAL_ROWS).sort()).toEqual(
      [...Object.keys(SPECIAL_METHOD_FORMS), ...Object.keys(SPECIAL_GLOBAL_FORMS)].sort(),
    );
  });
});

function runRows(label: string, rows: Record<string, Row>): void {
  describe(`fnmap differential — ${label}`, () => {
    for (const [name, row] of Object.entries(rows)) {
      if ("skip" in row) {
        test.skip(`${name} — SKIPPED: ${row.skip}`, () => {});
        continue;
      }
      test(name, async () => {
        // A row with no cases would satisfy the key-set completeness test
        // while exercising nothing — an explicit skip is the only way out.
        expect(row.cases.length).toBeGreaterThan(0);
        for (const c of row.cases) {
          await assertDifferential(c.expr, c.fixtures as never[], c.opts);
        }
      });
    }
  });
}

runRows("METHOD_MAP", METHOD_ROWS);
runRows("GLOBAL_MAP", GLOBAL_ROWS);
runRows("SPECIAL forms", SPECIAL_ROWS);
