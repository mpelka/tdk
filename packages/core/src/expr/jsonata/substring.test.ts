// substringAfter / substringBefore — recognised JSONata builtins (like assert),
// with author-side JS mirrors so they round-trip through the differential harness.

import { describe, expect, test } from "bun:test";
import { assertDifferential, jsonata, substringAfter, substringBefore } from "../../index.ts";

describe("emission", () => {
  test("substringAfter(str, chars) → $substringAfter(...)", () => {
    expect(jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/")).jsonata).toBe(
      '$substringAfter(ref, "user:default/")',
    );
  });

  test("substringBefore(str, chars) → $substringBefore(...)", () => {
    expect(jsonata<{ s: string }>((c) => substringBefore(c.s, "@")).jsonata).toBe('$substringBefore(s, "@")');
  });
});

describe("JS mirror semantics match the JSONata engine", () => {
  test("substringAfter agrees value-for-value (found + not-found)", async () => {
    const e = jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/"));
    await assertDifferential(e, [
      { ref: "user:default/baker042" }, // → "baker042"
      { ref: "no-prefix-here" }, // not found → whole string
      { ref: "user:default/" }, // → ""
    ]);
  });

  test("substringBefore agrees value-for-value (found + not-found)", async () => {
    const e = jsonata<{ s: string }>((c) => substringBefore(c.s, "@"));
    await assertDifferential(e, [
      { s: "alice@example.com" }, // → "alice"
      { s: "no-at-sign" }, // not found → whole string
    ]);
  });
});

describe("the requester-id extraction step", () => {
  test('substringAfter(ref, "user:default/") compiles to the expected JSONata', () => {
    // A roadie jsonata step that pulls the user id out of an entity ref:
    //   data: ${{ user }} ; expression: $substringAfter(ref, "user:default/")
    const e = jsonata<{ ref: string }>((c) => substringAfter(c.ref, "user:default/"));
    expect(e.jsonata).toBe('$substringAfter(ref, "user:default/")');
  });
});
