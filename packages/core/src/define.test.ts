// Unit tests for `step(...)`'s `when` option (ADR-0025 §5) — sugar for `if:`.
//
// `when` accepts the SAME typed predicates `showWhen` does (`field.is(v)`,
// `field.in(...)`, `all(...)`), compiled by `compileWhenExpr` (params.ts) to the
// Nunjucks boolean `${{ … }}` string `if:` needs. These tests pin the EXACT
// emission (equivalence proof against a hand-written `if:` string) and the
// error paths (`if` + `when` together, an unbound controller). `execute()`
// skip/run coverage — the runtime half of the fidelity proof — lives in
// execute.test.ts alongside the existing "evalIf — Backstage isTruthy
// fidelity" suite `.when()`'s emission is built to agree with.

import { describe, expect, test } from "bun:test";
import { all, p, step } from "./index.ts";

describe(".when() — exact Nunjucks emission", () => {
  test("a single .is() emits an unparenthesized `==` comparison", () => {
    const priority = p.enum(["Low", "Normal", "High"]);
    priority.setName("priority");
    const s = step("notify", "debug:log", { when: priority.is("High") });
    expect(s.if).toBe('${{ parameters.priority == "High" }}');
  });

  test(".in(...) emits the Nunjucks `in` membership operator", () => {
    const priority = p.enum(["Low", "Normal", "High"]);
    priority.setName("priority");
    const s = step("notify", "debug:log", { when: priority.in("Normal", "High") });
    expect(s.if).toBe('${{ parameters.priority in ["Normal", "High"] }}');
  });

  test("all(...) AND-composes with parens per condition, joined by `and`", () => {
    const problemArea = p.enum(["heating", "conveyor", "other"]);
    problemArea.setName("problemArea");
    const priority = p.enum(["Low", "Normal", "High"]);
    priority.setName("priority");
    const s = step("notify", "debug:log", {
      when: all(problemArea.is("other"), priority.in("Normal", "High")),
    });
    expect(s.if).toBe('${{ (parameters.problemArea == "other") and (parameters.priority in ["Normal", "High"]) }}');
  });

  test("a number value stays bare (no quotes)", () => {
    const urgency = p.number();
    urgency.setName("urgency");
    const s = step("notify", "debug:log", { when: urgency.is(3) });
    expect(s.if).toBe("${{ parameters.urgency == 3 }}");
  });

  test("a boolean value stays bare (no quotes)", () => {
    const flag = p.boolean();
    flag.setName("flag");
    const s = step("notify", "debug:log", { when: flag.is(true) });
    expect(s.if).toBe("${{ parameters.flag == true }}");
  });
});

describe(".when() — equivalence with the hand-written `if:` string", () => {
  test("compiles IDENTICALLY to the equivalent hand-authored `if:`", () => {
    const priority = p.enum(["Low", "Normal", "High"]);
    priority.setName("priority");

    const handWritten = step("notify", "debug:log", {
      if: '${{ parameters.priority == "High" }}',
      input: { msg: "urgent!" },
    });
    const viaWhen = step("notify", "debug:log", {
      when: priority.is("High"),
      input: { msg: "urgent!" },
    });

    expect(viaWhen).toEqual(handWritten);
  });
});

describe(".when() — error paths", () => {
  test("supplying both `if` and `when` throws, naming the step", () => {
    const priority = p.enum(["Low", "High"]);
    priority.setName("priority");
    expect(() => step("notify", "debug:log", { if: true, when: priority.is("High") })).toThrow(
      /step "notify": both `if` and `when` were given/,
    );
  });

  test("a controller that was never bound to a property name throws, pointing at the fix", () => {
    const orphan = p.enum(["a", "b"]); // never .setName'd — not part of any template
    expect(() => step("notify", "debug:log", { when: orphan.is("a") })).toThrow(/not part of this template/);
  });
});
