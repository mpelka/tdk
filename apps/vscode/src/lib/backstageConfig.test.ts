import { describe, expect, test } from "bun:test";
import { backstageSetup } from "./backstageConfig.ts";

describe("backstageSetup", () => {
  test("an empty base URL blocks with an actionable reason", () => {
    const s = backstageSetup("", "tok");
    expect(s.ready).toBe(false);
    if (s.ready) throw new Error("expected not-ready");
    expect(s.reason).toContain("tdk.backstage.baseUrl");
    expect(s.reason).toContain("Set Backstage Token");
  });

  test("a whitespace-only base URL blocks too", () => {
    expect(backstageSetup("   ", "tok").ready).toBe(false);
  });

  test("an undefined base URL blocks", () => {
    expect(backstageSetup(undefined, undefined).ready).toBe(false);
  });

  test("a base URL with a token is ready and carries both", () => {
    const s = backstageSetup("http://localhost:7007", "tok");
    expect(s.ready).toBe(true);
    if (!s.ready) throw new Error("expected ready");
    expect(s.baseUrl).toBe("http://localhost:7007");
    expect(s.token).toBe("tok");
    expect(s.hasToken).toBe(true);
  });

  test("a base URL WITHOUT a token is still ready (token is optional), hasToken false", () => {
    const s = backstageSetup("http://localhost:7007", undefined);
    expect(s.ready).toBe(true);
    if (!s.ready) throw new Error("expected ready");
    expect(s.token).toBeUndefined();
    expect(s.hasToken).toBe(false);
  });

  test("the base URL is trimmed", () => {
    const s = backstageSetup("  http://localhost:7007  ", "tok");
    if (!s.ready) throw new Error("expected ready");
    expect(s.baseUrl).toBe("http://localhost:7007");
  });

  test("a blank token is treated as no token", () => {
    const s = backstageSetup("http://localhost:7007", "   ");
    if (!s.ready) throw new Error("expected ready");
    expect(s.hasToken).toBe(false);
    expect(s.token).toBeUndefined();
  });
});
