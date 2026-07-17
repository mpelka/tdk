// Unit tests for the sugar added directly on top of `params.ts` (ADR-0025 §5):
//
//   - `p.choice` — sugar over the enum/enumNames pair. The load-bearing claim
//     is BYTE-IDENTICAL emission to the hand-written `p.string({ enum,
//     enumNames })` it stands in for (`p.choice` literally routes through the
//     same `StringParam` construction — see params.ts).
//   - `.orElse(default)` on a param `.ref` — the Nunjucks `default` filter,
//     with the default JSON-encoded into the filter. Type-flow coverage (the
//     `Ref<T | undefined>.orElse` narrowing and the `TypedInputValue`
//     composition) lives in typed-input.type-test.ts; `p.choice`'s typed
//     value union lives in choice.type-test.ts. `execute()` coverage for
//     `.orElse()` (renders the default when absent, the value when present)
//     lives in execute.test.ts.

import { describe, expect, test } from "bun:test";
import { p } from "./index.ts";

describe("p.choice — byte-identical to the hand-written p.string({ enum, enumNames })", () => {
  test("array form: enum only, in array order", () => {
    const viaChoice = p.choice(["deck", "convection", "rack"], { title: "Oven type", required: true });
    const viaString = p.string({ title: "Oven type", required: true, enum: ["deck", "convection", "rack"] });
    expect(JSON.stringify(viaChoice.toSchema())).toBe(JSON.stringify(viaString.toSchema()));
  });

  test("array form, no extra opts", () => {
    const viaChoice = p.choice(["A", "B"]);
    const viaString = p.string({ enum: ["A", "B"] });
    expect(JSON.stringify(viaChoice.toSchema())).toBe(JSON.stringify(viaString.toSchema()));
  });

  test("object form: enum from keys, enumNames from values, insertion order preserved", () => {
    const viaChoice = p.choice(
      { BK1: "Riverside", BK2: "Old Town", BK3: "Harbourfront" },
      { title: "Bakery site", required: true },
    );
    const viaString = p.string({
      title: "Bakery site",
      required: true,
      enum: ["BK1", "BK2", "BK3"],
      enumNames: ["Riverside", "Old Town", "Harbourfront"],
    });
    expect(JSON.stringify(viaChoice.toSchema())).toBe(JSON.stringify(viaString.toSchema()));
  });

  test("the compiled schema is the exact expected shape (key order included)", () => {
    const viaChoice = p.choice({ BK1: "Riverside", BK2: "Old Town" }, { title: "Bakery site" });
    expect(JSON.stringify(viaChoice.toSchema())).toBe(
      JSON.stringify({
        type: "string",
        title: "Bakery site",
        enumNames: ["Riverside", "Old Town"],
        enum: ["BK1", "BK2"],
      }),
    );
  });
});

describe(".orElse(default) — the Nunjucks default filter", () => {
  test("a string default is quoted/escaped", () => {
    const worklog = p.string();
    worklog.setName("worklog");
    const marker = worklog.ref.orElse("");
    expect(marker.render({ env: "" })).toBe('${{ parameters.worklog | default("") }}');
  });

  test("a number default stays bare", () => {
    const qty = p.number();
    qty.setName("qty");
    const marker = qty.ref.orElse(0);
    expect(marker.render({ env: "" })).toBe("${{ parameters.qty | default(0) }}");
  });

  test("a boolean default stays bare", () => {
    const flag = p.boolean();
    flag.setName("flag");
    const marker = flag.ref.orElse(false);
    expect(marker.render({ env: "" })).toBe("${{ parameters.flag | default(false) }}");
  });

  test("a string default with quotes/backslashes escapes correctly (real Nunjucks parses it)", () => {
    const note = p.string();
    note.setName("note");
    const marker = note.ref.orElse('say "hi"\\bye');
    expect(marker.render({ env: "" })).toBe('${{ parameters.note | default("say \\"hi\\"\\\\bye") }}');
  });

  test("an undefined default throws — an absent default has no meaning", () => {
    const worklog = p.string();
    worklog.setName("worklog");
    expect(() => worklog.ref.orElse(undefined)).toThrow(/must not be undefined/);
  });

  test("the JS oracle mirrors the Nunjucks `default` filter: fires ONLY on undefined", () => {
    const worklog = p.string();
    worklog.setName("worklog");
    const marker = worklog.ref.orElse("none");
    expect(marker.fn({ parameters: {}, steps: {}, secrets: {}, user: {} })).toBe("none");
    expect(marker.fn({ parameters: { worklog: "" }, steps: {}, secrets: {}, user: {} })).toBe("");
    expect(marker.fn({ parameters: { worklog: "baked" }, steps: {}, secrets: {}, user: {} })).toBe("baked");
  });
});
