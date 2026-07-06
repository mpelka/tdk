// Coverage for the `nj` API surface + integration through compile: a NunjucksExpr
// is a RawRef, so it flows through compile like `raw`/`jsonata`, compiling to a
// `${{ <nunjucks> }}` Scaffolder expression usable as input / output / `if`.

import { beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { _resetEnvRegistry, compile, p, Template, validate } from "../../index.ts";
import { isNunjucksExpr, NunjucksExpr, nj } from "./index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

beforeEach(() => _resetEnvRegistry());

describe("NunjucksExpr", () => {
  test("render()/toString() wrap the compiled Nunjucks in ${{ … }}", () => {
    const e = nj((c) => c.user);
    expect(e.render({ env: "test" })).toBe("${{ user }}");
    expect(e.toString()).toBe("${{ user }}");
    expect(String(e)).toBe("${{ user }}");
  });

  test("render() is env-independent", () => {
    const e = nj((c) => c.parameters.x);
    expect(e.render({ env: "test" })).toBe(e.render({ env: "prod" }));
  });

  test("exposes the compiled nunjucks and the JS oracle fn", () => {
    const e = nj<{ parameters: { x: number } }>((c) => c.parameters.x);
    expect(e.nunjucks).toBe("parameters.x");
    expect(e.fn({ parameters: { x: 7 } })).toBe(7);
  });
});

describe("isNunjucksExpr", () => {
  test("true for a NunjucksExpr, false for everything else", () => {
    expect(isNunjucksExpr(nj((c) => c.user))).toBe(true);
    expect(isNunjucksExpr(new NunjucksExpr("user", () => null))).toBe(true);
    expect(isNunjucksExpr({})).toBe(false);
    expect(isNunjucksExpr(null)).toBe(false);
    expect(isNunjucksExpr("user")).toBe(false);
  });
});

describe("nj through compile", () => {
  class T extends Template {
    id = "nj-tpl";
    title = "NJ";
    type = "service";
    params = { request_for: p.string() };
    build() {
      return [
        {
          id: "fetch",
          action: "roadiehq:utils:jsonata",
          // nj as a step `input` value (object members), and as `if`.
          input: { data: nj((c) => c.user) },
          if: nj((c) => c.secrets.token),
        },
      ];
    }
    output = {
      requester: nj((c) => c.user.entity.metadata.name || c.steps["customer-id-fetch"].output.result.toUpperCase()),
    };
  }

  test("nj input renders to a ${{ nunjucks }} string", () => {
    const { object } = compile(new T(), nonprod);
    expect(object.spec.steps[0]!.input!.data).toBe("${{ user }}");
  });

  test("nj works as a step `if` condition", () => {
    const { object } = compile(new T(), nonprod);
    expect(object.spec.steps[0]!.if).toBe("${{ secrets.token }}");
  });

  test("nj works as an output value", () => {
    const { object } = compile(new T(), nonprod);
    expect(object.spec.output!.requester).toBe(
      '${{ (user.entity.metadata.name or steps["customer-id-fetch"].output.result | upper) }}',
    );
  });

  test("yaml round-trips with the expression intact + schema-valid", async () => {
    const { object, yaml } = compile(new T(), nonprod);
    const parsed = parse(yaml);
    expect(parsed.spec.steps[0].input.data).toBe("${{ user }}");
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});
