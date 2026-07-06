// Differential-harness tests: run the author's TS function in JS AND the
// compiled JSONata, and assert they agree on every fixture. The showcase is the
// order-ticket builder; the singleton-flattening case gets special attention.

import { describe, expect, test } from "bun:test";
import type { TicketCtx } from "../../__fixtures__/expressions.ts";
import { orderTicket } from "../../__fixtures__/expressions.ts";
import { assertDifferential, differential, jsonata } from "../../index.ts";

describe("order-ticket showcase (empty / singleton / many)", () => {
  const fixtures: TicketCtx[] = [
    // empty members → "Unassigned"
    { parameters: { cakeName: "cake-a", owner: { members: [] }, tags: ["sponge"] } },
    // SINGLETON members → the JSONata singleton-flattening trap
    {
      parameters: {
        cakeName: "cake-b",
        owner: { members: [{ email: "a@x.io" }] },
        tags: ["sponge", "crew-x"],
      },
    },
    // many members
    {
      parameters: {
        cakeName: "cake-c",
        owner: { members: [{ email: "a@x.io" }, { email: "b@x.io" }] },
        tags: [],
      },
    },
  ];

  test("compiled JSONata matches the TS oracle on every fixture", async () => {
    const result = await differential(orderTicket, fixtures);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  test("assertDifferential does not throw", async () => {
    await expect(assertDifferential(orderTicket, fixtures)).resolves.toBeUndefined();
  });

  test("singleton case specifically agrees (no flattening drift)", async () => {
    const singleton = fixtures[1]!;
    const result = await differential(orderTicket, [singleton]);
    const c = result.cases[0]!;
    // JS oracle produces the joined-string description.
    expect((c.expected as any).description).toBe("Owned by a@x.io");
    expect(c.equal).toBe(true);
  });
});

describe("singleton-flattening: .map() used as a standalone array", () => {
  type C = { users: { email: string }[] };
  const emails = jsonata<C>((c) => ({ emails: c.users.map((u) => u.email) }));

  test("emits array-context [users.email]", () => {
    expect(emails.jsonata).toBe('{"emails": [users.email]}');
  });

  test("empty / singleton / many all match JS .map() array semantics", async () => {
    const result = await differential(emails, [
      { users: [] }, // → []
      { users: [{ email: "only@x" }] }, // singleton → ["only@x"], NOT "only@x"
      { users: [{ email: "a@x" }, { email: "b@x" }] }, // → ["a@x","b@x"]
    ]);
    expect(result.ok).toBe(true);
    expect((result.cases[1]!.actual as any).emails).toEqual(["only@x"]);
  });
});

describe("differential reports mismatches without throwing", () => {
  test("ok=false + mismatch indices when oracle and JSONata diverge", async () => {
    // Construct a deliberately diverging jsonata via the raw escape hatch: the JS
    // side is overwritten to a constant that won't match the JSONata.
    type C = { n: number };
    const e = jsonata<C>((c) => c.n + 1);
    // Monkeypatch the oracle to force a mismatch.
    (e as any).fn = () => 999;
    const result = await differential(e, [{ n: 1 }, { n: 2 }]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([0, 1]);
  });

  test("assertDifferential throws a detailed error on mismatch", async () => {
    type C = { n: number };
    const e = jsonata<C>((c) => c.n);
    (e as any).fn = () => 12345;
    await expect(assertDifferential(e, [{ n: 1 }])).rejects.toThrow(/disagreed/);
  });

  test("a non-Error / non-object throw is reported via String()", async () => {
    type C = { n: number };
    const e = jsonata<C>((c) => c.n);
    // Oracle throws a bare primitive (not an Error, no `.message`).
    (e as any).fn = () => {
      throw "boom-string";
    };
    const result = await differential(e, [{ n: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.cases[0]!.expected).toBe("Error: boom-string");
  });

  test("the mismatch report survives an unserializable (circular) fixture", async () => {
    type C = { n: number };
    const e = jsonata<C>((c) => c.n);
    (e as any).fn = () => 999; // force a mismatch so the report is built
    const circular: any = { n: 1 };
    circular.self = circular; // JSON.stringify(circular) throws → json() catch
    await expect(assertDifferential(e, [circular])).rejects.toThrow(/disagreed/);
  });
});

describe("function-map round-trips via differential", () => {
  test("string ops match", async () => {
    type C = { s: string };
    const e = jsonata<C>((c) => ({
      up: c.s.toUpperCase(),
      lo: c.s.toLowerCase(),
      trimmed: c.s.trim(),
      has: c.s.includes("a"),
    }));
    const r = await differential(e, [{ s: "  AbCa  " }, { s: "xyz" }]);
    expect(r.ok).toBe(true);
  });

  test("ternary + comparison + concat match", async () => {
    type C = { count: number; name: string };
    const e = jsonata<C>((c) => (c.count > 0 ? `has ${c.count}` : `none for ${c.name}`));
    const r = await differential(e, [
      { count: 0, name: "x" },
      { count: 3, name: "y" },
    ]);
    expect(r.ok).toBe(true);
  });

  test("filter predicate matches — including SINGLE-match and NO-match fixtures", async () => {
    // These fixtures used to be dodged: an unwrapped `items[pred]` flattens a
    // single match to a scalar and DROPS the object key for an empty match.
    // The `[ ... ]` wrap keeps both array-shaped, so they now agree with JS.
    type C = { items: { active: boolean; id: number }[] };
    const e = jsonata<C>((c) => ({ active: c.items.filter((i) => i.active) }));
    const r = await differential(e, [
      {
        items: [
          { active: true, id: 1 },
          { active: false, id: 2 },
        ],
      }, // exactly ONE match → must stay [x]
      { items: [{ active: false, id: 3 }] }, // NO match → must stay [] (key kept)
      {
        items: [
          { active: true, id: 4 },
          { active: true, id: 5 },
        ],
      },
    ]);
    expect(r.ok).toBe(true);
    expect((r.cases[0]!.actual as any).active).toEqual([{ active: true, id: 1 }]);
    expect((r.cases[1]!.actual as any).active).toEqual([]);
  });
});
