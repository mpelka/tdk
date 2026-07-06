// Unit tests for the `TDK: Set Backstage Base URL` command's pure input logic:
// the InputBox's live validation (empty = clear = ok; else must be an http/https
// URL) and the normalization of the accepted value into the setting write.

import { describe, expect, test } from "bun:test";
import { normalizeBaseUrl, validateBaseUrl } from "./baseUrlInput.ts";

describe("validateBaseUrl", () => {
  test("an empty value is valid — it clears the setting (feature off)", () => {
    expect(validateBaseUrl("")).toBeUndefined();
    expect(validateBaseUrl("   ")).toBeUndefined();
  });

  test("well-formed http/https URLs are valid", () => {
    expect(validateBaseUrl("http://localhost:7007")).toBeUndefined();
    expect(validateBaseUrl("https://backstage.bakery.example")).toBeUndefined();
    expect(validateBaseUrl("https://backstage.bakery.example/api")).toBeUndefined();
  });

  test("surrounding whitespace is trimmed before validating", () => {
    expect(validateBaseUrl("  http://localhost:7007  ")).toBeUndefined();
  });

  test("a non-URL is rejected with an actionable message", () => {
    expect(validateBaseUrl("not a url")).toMatch(/http\/https URL/);
    expect(validateBaseUrl("localhost:7007")).toBeDefined(); // no scheme → URL parses it as scheme "localhost:" — still not http(s)
  });

  test("a non-http(s) scheme is rejected", () => {
    expect(validateBaseUrl("ftp://backstage.bakery.example")).toMatch(/http or https/);
    expect(validateBaseUrl("file:///tmp/backstage")).toMatch(/http or https/);
  });
});

describe("normalizeBaseUrl", () => {
  test("empty (or whitespace) normalizes to undefined — the setting is cleared", () => {
    expect(normalizeBaseUrl("")).toBeUndefined();
    expect(normalizeBaseUrl("  ")).toBeUndefined();
  });

  test("a URL normalizes to its trimmed self", () => {
    expect(normalizeBaseUrl(" http://localhost:7007 ")).toBe("http://localhost:7007");
  });
});
