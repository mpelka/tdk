// Differential-harness tests: run the author's TS function in JS AND render the
// compiled Nunjucks with the real `nunjucks` lib, asserting they agree on every
// fixture (the oracle value scalarized the way Nunjucks would print it).

import { describe, expect, test } from "bun:test";
import { assertDifferentialNj, differentialNj, njString, renderNj } from "./differential.ts";
import { nj, njDefault } from "./index.ts";

type Ctx = {
  parameters: { name?: string; scheduled_start?: string; region?: string };
  user: { entity: { metadata: { name: string } } };
  steps: Record<string, { output: { result: string } }>;
};

describe("each mapping renders identically to its TS oracle", () => {
  test("member access", () => {
    const e = nj<Ctx>((c) => c.parameters.name);
    const r = differentialNj(e, [
      { parameters: { name: "alice" } } as Ctx,
      { parameters: {} } as Ctx, // undefined → ""
    ]);
    expect(r.ok).toBe(true);
  });

  test('empty default x || "" matches on present / empty / absent', () => {
    const e = nj<Ctx>((c) => c.parameters.scheduled_start || "");
    const r = differentialNj(e, [
      { parameters: { scheduled_start: "2026-01-01" } } as Ctx,
      { parameters: { scheduled_start: "" } } as Ctx,
      { parameters: {} } as Ctx,
    ]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["2026-01-01", "", ""]);
  });

  test("nullish default x ?? v and njDefault agree (only absent → fallback)", () => {
    const e1 = nj<Ctx>((c) => c.parameters.region ?? "eu");
    const e2 = nj<Ctx>((c) => njDefault(c.parameters.region, "eu"));
    const fx = [{ parameters: { region: "us" } } as Ctx, { parameters: {} } as Ctx];
    expect(differentialNj(e1, fx).ok).toBe(true);
    expect(differentialNj(e2, fx).ok).toBe(true);
  });

  test("filters: upper / lower / trim", () => {
    const e = nj<Ctx>((c) => c.parameters.name!.toUpperCase());
    const r = differentialNj(e, [{ parameters: { name: "abc" } } as Ctx]);
    expect(r.ok).toBe(true);
    expect(r.cases[0]!.actual).toBe("ABC");
  });

  test("|| with | upper (the or-upper showcase) renders correctly", () => {
    const e = nj<Ctx>((c) => c.user.entity.metadata.name || c.steps["customer-id-fetch"].output.result.toUpperCase());
    const r = differentialNj(e, [
      // name present → name wins (filter not applied)
      {
        user: { entity: { metadata: { name: "Alice" } } },
        steps: { "customer-id-fetch": { output: { result: "fallback" } } },
        parameters: {},
      } as Ctx,
      // name empty → fallback, uppercased
      {
        user: { entity: { metadata: { name: "" } } },
        steps: { "customer-id-fetch": { output: { result: "baker-042" } } },
        parameters: {},
      } as Ctx,
    ]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["Alice", "BAKER-042"]);
  });

  test("ternary renders the Nunjucks-order branch", () => {
    const e = nj<{ parameters: { flag: boolean } }>((c) => (c.parameters.flag ? "on" : "off"));
    const r = differentialNj(e, [{ parameters: { flag: true } }, { parameters: { flag: false } }]);
    expect(r.ok).toBe(true);
    expect(r.cases.map((c) => c.actual)).toEqual(["on", "off"]);
  });
});

describe("scalarization", () => {
  test("njString maps null/undefined to empty and stringifies the rest", () => {
    expect(njString(null)).toBe("");
    expect(njString(undefined)).toBe("");
    expect(njString(true)).toBe("true");
    expect(njString(5)).toBe("5");
    expect(njString("x")).toBe("x");
    expect(njString(["a", "b"])).toBe("a,b");
  });

  test("renderNj tolerates a null fixture", () => {
    expect(renderNj('"literal"', null)).toBe("literal");
  });
});

describe("differential reports mismatches without throwing", () => {
  test("ok=false + mismatch indices when oracle and Nunjucks diverge", () => {
    const e = nj<{ parameters: { x: string } }>((c) => c.parameters.x);
    (e as any).fn = () => "DIFFERENT";
    const r = differentialNj(e, [{ parameters: { x: "actual" } }]);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([0]);
  });

  test("assertDifferentialNj throws a detailed error on mismatch", () => {
    const e = nj<{ parameters: { x: string } }>((c) => c.parameters.x);
    (e as any).fn = () => "DIFFERENT";
    expect(() => assertDifferentialNj(e, [{ parameters: { x: "a" } }])).toThrow(/disagreed/);
  });

  test("assertDifferentialNj is silent when all agree", () => {
    const e = nj<{ parameters: { x: string } }>((c) => c.parameters.x);
    expect(() => assertDifferentialNj(e, [{ parameters: { x: "ok" } }])).not.toThrow();
  });

  test("an oracle throw is captured as an Error: mismatch", () => {
    const e = nj<{ parameters: { x: string } }>((c) => c.parameters.x);
    (e as any).fn = () => {
      throw new Error("boom");
    };
    const r = differentialNj(e, [{ parameters: { x: "a" } }]);
    expect(r.ok).toBe(false);
    expect(r.cases[0]!.expected).toBe("Error: boom");
  });

  test("the mismatch report survives a circular fixture", () => {
    const e = nj<{ parameters: { x: string } }>((c) => c.parameters.x);
    (e as any).fn = () => "DIFFERENT";
    const circular: any = { parameters: { x: "a" } };
    circular.self = circular;
    expect(() => assertDifferentialNj(e, [circular])).toThrow(/disagreed/);
  });
});
