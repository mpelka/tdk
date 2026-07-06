// Direct unit tests for `formatError` — the stderr-formatting contract the VS
// Code extension and coding-agent loops parse. Pure: no subprocess, no IO.

import { describe, expect, test } from "bun:test";
import { formatError } from "./errors.ts";

describe("formatError", () => {
  test("a bare Error surfaces its message", () => {
    expect(formatError(new Error("plain failure"))).toBe("plain failure");
  });

  test("a primitive throw surfaces bare (String(err))", () => {
    expect(formatError("boom")).toBe("boom");
    expect(formatError(42)).toBe("42");
  });

  test("a message-bearing non-Error prefers its .message over String()", () => {
    // A position-less Bun ResolveMessage-alike: not instanceof Error, has .message.
    const resolveMessageLike = { message: "Cannot find module 'x'", toString: () => "ResolveMessage: Cannot find…" };
    expect(formatError(resolveMessageLike)).toBe("Cannot find module 'x'");
  });

  test("a bare single BuildMessage renders file:line:col: message", () => {
    // Bun raises exactly ONE build error as a bare BuildMessage (NOT an Error)
    // carrying `position` directly — the position must not be lost.
    const buildMessage = {
      message: "Unexpected end of file",
      position: { file: "/abs/broken.ts", line: 1, column: 10 },
    };
    expect(formatError(buildMessage)).toBe("/abs/broken.ts:1:10: Unexpected end of file");
  });

  test("an AggregateError-shaped value renders each error as file:line:col", () => {
    const aggregate = {
      errors: [
        { message: "first", position: { file: "/a.ts", line: 2, column: 3 } },
        { message: "second", position: { file: "/b.ts", line: 5, column: 1 } },
      ],
    };
    expect(formatError(aggregate)).toBe("/a.ts:2:3: first\n/b.ts:5:1: second");
  });

  test("column defaults to 1 when absent but line is present", () => {
    const buildMessage = { message: "oops", position: { file: "/x.ts", line: 7 } };
    expect(formatError(buildMessage)).toBe("/x.ts:7:1: oops");
  });

  test("a position without file/line drops the location prefix", () => {
    const buildMessage = { message: "no location", position: {} };
    expect(formatError(buildMessage)).toBe("no location");
  });

  test("a bare non-message object falls back to String()", () => {
    expect(formatError({ nope: true })).toBe("[object Object]");
  });
});
