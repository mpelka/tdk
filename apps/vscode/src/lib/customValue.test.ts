// Unit tests for the fallback custom-field value parser: JSON round-trips as its
// type, bare words stay strings, empty stays "", and half-typed JSON never throws.

import { describe, expect, test } from "bun:test";
import { parseCustomFieldValue } from "./customValue.ts";

describe("parseCustomFieldValue — JSON", () => {
  test("parses an object", () => {
    expect(parseCustomFieldValue('{"path":"bakery/ovens"}')).toEqual({ path: "bakery/ovens" });
  });
  test("parses an array", () => {
    expect(parseCustomFieldValue("[1, 2, 3]")).toEqual([1, 2, 3]);
  });
  test("parses a number", () => {
    expect(parseCustomFieldValue("42")).toBe(42);
    expect(parseCustomFieldValue("-3.5")).toBe(-3.5);
  });
  test("parses booleans and null", () => {
    expect(parseCustomFieldValue("true")).toBe(true);
    expect(parseCustomFieldValue("false")).toBe(false);
    expect(parseCustomFieldValue("null")).toBeNull();
  });
  test("parses a quoted JSON string to the unquoted string", () => {
    expect(parseCustomFieldValue('"deck-3000"')).toBe("deck-3000");
  });
});

describe("parseCustomFieldValue — strings", () => {
  test("keeps a bare word as a string", () => {
    expect(parseCustomFieldValue("deck-3000")).toBe("deck-3000");
  });
  test("keeps free text as a string", () => {
    expect(parseCustomFieldValue("Signature Bakes")).toBe("Signature Bakes");
  });
  test("keeps a leading-digit word (not valid JSON) as a string", () => {
    expect(parseCustomFieldValue("3000-deck")).toBe("3000-deck");
  });
});

describe("parseCustomFieldValue — edge cases", () => {
  test("empty / whitespace stays an empty string", () => {
    expect(parseCustomFieldValue("")).toBe("");
    expect(parseCustomFieldValue("   ")).toBe("");
  });
  test("half-typed JSON returns the raw string (never throws)", () => {
    expect(parseCustomFieldValue('{"path":')).toBe('{"path":');
    expect(parseCustomFieldValue("[1,")).toBe("[1,");
  });
  test("preserves surrounding whitespace of a plain string", () => {
    // A bare string that isn't JSON keeps the original text (untrimmed).
    expect(parseCustomFieldValue("  hi there  ")).toBe("  hi there  ");
  });
});
