// `.padStart` / `.padEnd` → JSONata `$pad`, and `.slice` → JSONata `$substring`.
//
// Two-part coverage per mapping (mirrors substring.test.ts):
//   1. EMISSION — the exact JSONata string the transpiler produces.
//   2. DIFFERENTIAL — the TS oracle (native String method) and the compiled
//      JSONata agree value-for-value across representative inputs.
//
// $pad sign convention (verified here): a POSITIVE width pads on the RIGHT
// (≡ padEnd), a NEGATIVE width pads on the LEFT (≡ padStart). `.slice` takes an
// END index while `$substring` takes a LENGTH, so the two-arg literal form is
// compiled as `$substring(s, start, max(0, end - start))`.

import { describe, expect, test } from "bun:test";
import { assertDifferential, jsonata, TranspileError } from "../../index.ts";

describe("emission — .padStart / .padEnd → $pad", () => {
  test(".padEnd(n, ch) → $pad(s, n, ch) (positive width = right pad)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.padEnd(8, "0")).jsonata).toBe('$pad(s, 8, "0")');
  });

  test(".padStart(n, ch) → $pad(s, -(n), ch) (negative width = left pad)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.padStart(8, "0")).jsonata).toBe('$pad(s, -(8), "0")');
  });

  test(".padStart(n) default char → $pad(s, -(n))", () => {
    expect(jsonata<{ s: string }>((c) => c.s.padStart(4)).jsonata).toBe("$pad(s, -(4))");
  });

  test(".padEnd(n) default char → $pad(s, n)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.padEnd(4)).jsonata).toBe("$pad(s, 4)");
  });

  test("a non-literal width is negated as a whole for .padStart", () => {
    expect(jsonata<{ s: string; w: number }>((c) => c.s.padStart(c.w, "0")).jsonata).toBe('$pad(s, -(w), "0")');
  });
});

describe("differential — .padStart / .padEnd agree with the JSONata engine", () => {
  test(".padStart left-pads (short / exact / already-longer / multi-char / default)", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padStart(5, "0")),
      [{ s: "7" }, { s: "12" }, { s: "12345" }, { s: "123456" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padStart(6, "ab")),
      [{ s: "7" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padStart(4)),
      [{ s: "9" }, { s: "9999" }],
    );
  });

  test(".padEnd right-pads (short / exact / already-longer / multi-char / default)", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padEnd(5, "0")),
      [{ s: "7" }, { s: "12345" }, { s: "123456" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padEnd(6, "ab")),
      [{ s: "7" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.padEnd(4)),
      [{ s: "9" }, { s: "9999" }],
    );
  });

  test("a non-literal width works through the negation", async () => {
    await assertDifferential(
      jsonata<{ s: string; w: number }>((c) => c.s.padStart(c.w, "0")),
      [
        { s: "5", w: 8 },
        { s: "5", w: 1 },
      ],
    );
  });
});

describe("emission — .slice → $substring", () => {
  test(".slice(start) → $substring(s, start)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.slice(2)).jsonata).toBe("$substring(s, 2)");
  });

  test(".slice(negativeStart) → $substring(s, -n) (one-arg is fully general)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.slice(-3)).jsonata).toBe("$substring(s, -3)");
  });

  test(".slice(computedStart) → $substring(s, start)", () => {
    expect(jsonata<{ s: string; i: number }>((c) => c.s.slice(c.i)).jsonata).toBe("$substring(s, i)");
  });

  test(".slice(start, end) literals → $substring(s, start, end - start)", () => {
    expect(jsonata<{ s: string }>((c) => c.s.slice(1, 4)).jsonata).toBe("$substring(s, 1, 3)");
  });

  test(".slice(start, end) where end <= start → length clamps to 0", () => {
    expect(jsonata<{ s: string }>((c) => c.s.slice(4, 1)).jsonata).toBe("$substring(s, 4, 0)");
    expect(jsonata<{ s: string }>((c) => c.s.slice(2, 2)).jsonata).toBe("$substring(s, 2, 0)");
  });
});

describe("differential — .slice agrees with the JSONata engine", () => {
  test(".slice(start) — positive / negative / out-of-range", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(2)),
      [{ s: "hello" }, { s: "ab" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(-2)),
      [{ s: "hello" }, { s: "x" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(10)),
      [{ s: "hello" }],
    );
  });

  test(".slice(start, end) literals — normal / empty / end-past-length / reversed", async () => {
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(1, 4)),
      [{ s: "hello" }, { s: "ab" }, { s: "" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(0, 8)),
      [{ s: "abc123xyz" }, { s: "short" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(2, 2)),
      [{ s: "hello" }],
    );
    await assertDifferential(
      jsonata<{ s: string }>((c) => c.s.slice(4, 1)),
      [{ s: "hello" }],
    );
  });
});

describe("rejects — what is NOT a clean $substring translation", () => {
  test("two-arg .slice with a NON-LITERAL index points at raw.jsonata", () => {
    expect(() => jsonata<{ s: string; i: number; j: number }>((c) => c.s.slice(c.i, c.j))).toThrow(TranspileError);
    expect(() => jsonata<{ s: string; i: number; j: number }>((c) => c.s.slice(c.i, c.j))).toThrow(/raw\.jsonata/);
  });

  test("two-arg .slice with a NEGATIVE end index is rejected (can't become a length)", () => {
    // `-1` parses as unary-minus, not a numeric literal, so it falls through to
    // the reject branch rather than computing a bogus length.
    expect(() => jsonata<{ s: string }>((c) => c.s.slice(0, -1))).toThrow(/non-negative integer literal/);
  });
});
