// Integration: how `jsonata(...)` flows through compile.
//
// CORRECT: its `.jsonata` STRING feeds a `roadiehq:utils:jsonata` step's
// `expression:` field, and the artifact stays schema-valid.
// REJECTED: the JsonataExpr OBJECT used as a `${{ }}` interpolation value (step
// input, step output, or `if`) — Backstage's `${{ }}` is Nunjucks and cannot
// evaluate JSONata, so compile throws a pointed error (#30).

import { beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { OrderTicketTemplate } from "../../__fixtures__/templates.ts";
import { _resetEnvRegistry, compile, jsonata, p, Template, validate } from "../../index.ts";

const nonprod = { env: "test", outDir: "dist/nonprod" } as const;

beforeEach(() => _resetEnvRegistry());

describe("jsonata in a roadie expression: field (the correct pattern)", () => {
  test("the .jsonata string compiles into the step's expression: field", () => {
    const { object } = compile(new OrderTicketTemplate(), nonprod);
    const input = object.spec.steps[0]!.input as { expression: string };
    // A plain STRING (not a `${{ }}` wrapper) — the roadie action evaluates it.
    expect(typeof input.expression).toBe("string");
    expect(input.expression.startsWith("${{")).toBe(false);
    expect(input.expression).toContain('"summary"');
    expect(input.expression).toContain("$join([parameters.owner.members.email]");
  });

  test("compiled artifact still passes the Backstage schema (M1 validate)", async () => {
    const { object } = compile(new OrderTicketTemplate(), nonprod);
    const { valid, errors } = await validate(object);
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });

  test("yaml round-trips with the expression intact", () => {
    const { yaml } = compile(new OrderTicketTemplate(), nonprod);
    const parsed = parse(yaml);
    const expression = parsed.spec.steps[0].input.expression as string;
    expect(expression).toContain('"summary"');
    expect(expression).not.toContain("${{");
  });
});

describe("compile REJECTS a jsonata(...) object in a ${{ }} interpolation (#30)", () => {
  test("as a step INPUT value", () => {
    class T extends Template {
      id = "jsonata-in";
      title = "Expr In";
      type = "service";
      params = { name: p.string() };
      build() {
        return [
          {
            id: "file",
            action: "http:backstage:request",
            input: { body: jsonata<{ parameters: { name: string } }>((c) => ({ n: c.parameters.name })) },
          },
        ];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/jsonata\(\.\.\.\) expression was used at step "file" input\.body/);
    // The message names the mechanism + both correct alternatives.
    expect(() => compile(new T(), nonprod)).toThrow(/Nunjucks and cannot evaluate JSONata/);
    expect(() => compile(new T(), nonprod)).toThrow(/roadiehq:utils:jsonata step's `expression:` field/);
    expect(() => compile(new T(), nonprod)).toThrow(/use nj\(\.\.\.\) instead/);
  });

  test("as a step OUTPUT value", () => {
    type C = { parameters: { name: string } };
    class T extends Template {
      id = "jsonata-out";
      title = "Expr Out";
      type = "service";
      params = { name: p.string() };
      build() {
        return [{ id: "s", action: "debug:log" }];
      }
      output = {
        greeting: jsonata<C>((c) => `hello ${c.parameters.name}`),
      };
    }
    expect(() => compile(new T(), nonprod)).toThrow(/jsonata\(\.\.\.\) expression was used at output\.greeting/);
  });

  test("as a step `if` condition", () => {
    type C = { parameters: { enabled: boolean } };
    class T extends Template {
      id = "jsonata-if";
      title = "Expr If";
      type = "service";
      params = { enabled: p.boolean() };
      build() {
        return [
          {
            id: "s",
            action: "debug:log",
            if: jsonata<C>((c) => c.parameters.enabled === true),
          },
        ];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(/jsonata\(\.\.\.\) expression was used at step "s" `if`/);
  });

  test("nested in a step input array/object still names its path", () => {
    class T extends Template {
      id = "jsonata-nested";
      title = "Expr Nested";
      type = "service";
      params = {};
      build() {
        return [
          {
            id: "s",
            action: "debug:log",
            input: { items: [{ payload: jsonata<{ parameters: unknown }>((c) => c.parameters) }] },
          },
        ];
      }
    }
    expect(() => compile(new T(), nonprod)).toThrow(
      /jsonata\(\.\.\.\) expression was used at step "s" input\.items\[0\]\.payload/,
    );
  });
});

describe("raw.jsonata / jsonata.raw escape hatch", () => {
  test("inlines verbatim JSONata, validated by parsing", () => {
    const e = jsonata.raw`$sum(parameters.amounts)`;
    expect(e.jsonata).toBe("$sum(parameters.amounts)");
  });

  test("invalid JSONata in the escape hatch throws", () => {
    expect(() => jsonata.raw`{{{ not jsonata`).toThrow(/does not parse/);
  });
});
