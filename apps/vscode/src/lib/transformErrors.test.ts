// Unit tests for the pure error humanizer (transformErrors.ts). Covers the "required"
// rewrite, the schema-authored `errorMessage` passthrough (ajv-errors), and unknown
// messages surviving unchanged.

import { describe, expect, test } from "bun:test";
import type { RJSFValidationError } from "@rjsf/utils";
import { humanizeMessage, transformErrors } from "./transformErrors.ts";

describe("humanizeMessage — a single ajv message", () => {
  test("`must have required property 'X'` becomes `X is required`", () => {
    expect(humanizeMessage("must have required property 'contactEmail'", "")).toBe("ContactEmail is required");
  });

  test("prefers the ajv-quoted property over the RJSF parent path", () => {
    // On a required error RJSF's `property` points at the PARENT object, not the
    // missing child — the quoted name is the reliable one.
    expect(humanizeMessage("must have required property 'orderType'", ".someParent")).toBe("OrderType is required");
  });

  test("an unknown message is returned unchanged (trimmed)", () => {
    expect(humanizeMessage("must be equal to one of the allowed values", ".packaging")).toBe(
      "must be equal to one of the allowed values",
    );
  });

  test("an empty / undefined message returns empty string", () => {
    expect(humanizeMessage(undefined, ".x")).toBe("");
    expect(humanizeMessage("   ", ".x")).toBe("");
  });
});

describe("transformErrors — the RJSF adapter over the error list", () => {
  const err = (over: Partial<RJSFValidationError>): RJSFValidationError => ({
    stack: "",
    ...over,
  });

  test("rewrites a required error's message and stack", () => {
    const out = transformErrors([
      err({ name: "required", message: "must have required property 'contactEmail'", property: "" }),
    ]);
    expect(out[0]?.message).toBe("ContactEmail is required");
    expect(out[0]?.stack).toBe("ContactEmail is required");
  });

  test("leaves a schema-authored errorMessage (ajv-errors) verbatim", () => {
    const original = err({
      name: "errorMessage",
      message: "Enter a valid delivery slot (morning, noon, or evening).",
      property: ".slot",
    });
    const out = transformErrors([original]);
    // The author already wrote it for the user — unchanged, same object.
    expect(out[0]).toBe(original);
    expect(out[0]?.message).toBe("Enter a valid delivery slot (morning, noon, or evening).");
  });

  test("passes an unrecognized message through unchanged (same object identity)", () => {
    const original = err({
      name: "enum",
      message: "must be equal to one of the allowed values",
      property: ".packaging",
    });
    const out = transformErrors([original]);
    expect(out[0]).toBe(original); // untouched — no needless clone
  });

  test("maps a mixed list, rewriting only what it recognizes", () => {
    const out = transformErrors([
      err({ name: "required", message: "must have required property 'name'", property: "" }),
      err({ name: "enum", message: "must be equal to one of the allowed values", property: ".kind" }),
    ]);
    expect(out.map((e) => e.message)).toEqual(["Name is required", "must be equal to one of the allowed values"]);
  });
});
