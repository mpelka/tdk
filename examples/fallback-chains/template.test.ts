// Tests for the Delivery Slot Notifier.
//
// nj is string-valued, so the differential is Nunjucks-flavoured:
//   - per expression, render the COMPILED nj AND the gold's HAND-WRITTEN nj with the
//     real nunjucks engine (`renderNj`) and assert the same string, across fixtures
//     covering present / null / absent / "" — value-equivalence, never byte-equality.
//   - `assertDifferentialNj` cross-checks each compiled nj against its TS oracle.
//   - `assertExecuteAgainstGold` for whole-run agreement; schema-validate both sides.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertDifferentialNj,
  assertExecuteAgainstGold,
  assertValid,
  compile,
  execute,
  nj,
  renderNj,
  validate,
} from "@tdk/core";
import { parse } from "yaml";
import { scenarios } from "./__fixtures__/scenarios.ts";
import { DeliverySlotNotifier, type NotifierCtx } from "./template.ts";

const nonprod = { env: "test", outDir: "" } as const;
const gold = readFileSync(new URL("./gold-standard.yaml", import.meta.url), "utf8");

const { object } = compile(DeliverySlotNotifier, nonprod);
const goldNotify = parse(gold).spec.steps[1].input as Record<string, string>;
const mineNotify = object.spec.steps[1]!.input as Record<string, string>;

/** Strip the `${{ … }}` wrapper so `renderNj` (which adds `{{ … }}`) can render it. */
const inner = (s: string) => s.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "");

// The fallback matrix: present / null / absent / empty-string, named / missing.
const ctxFixtures: NotifierCtx[] = [
  {
    parameters: { requestedSlot: "9am-slot", contactName: "Baker Sam", urgency: 4 },
    steps: { "fetch-baker": { output: { name: "north-riverside-bakery" } } },
  },
  {
    parameters: { requestedSlot: null, urgency: 2 },
    steps: { "fetch-baker": { output: { name: "west-park-bakery" } } },
  },
  {
    parameters: { urgency: 3 },
    steps: { "fetch-baker": { output: { name: "south-end-bakery" } } },
  },
  {
    parameters: { requestedSlot: "", contactName: "", urgency: 1 },
    steps: { "fetch-baker": { output: { name: "east-side-bakery" } } },
  },
];

describe("delivery-slot-notifier — structure & planning (v2)", () => {
  test("two effects: the baker lookup then the notification (ordered by data ref)", () => {
    // `notify` reads `fetch-baker`'s output in two nj expressions, so the planner
    // orders it AFTER `fetch-baker` even though there is no hard step chain.
    expect(object.spec.steps.map((s) => ({ id: s.id, action: s.action }))).toEqual([
      { id: "fetch-baker", action: "http:backstage:request" },
      { id: "notify", action: "debug:log" },
    ]);
  });

  test("the notify step carries the five fallback expressions", () => {
    expect(Object.keys(mineNotify).sort()).toEqual(["banner", "recipient", "region", "slot", "tier"]);
  });

  test("ui:order is inferred from the page's source order", () => {
    const pages = object.spec.parameters as Array<{ title: string; "ui:order"?: string[] }>;
    expect(pages.map((p) => ({ title: p.title, order: p["ui:order"] }))).toEqual([
      { title: "Delivery", order: ["requestedSlot", "contactName", "urgency"] },
    ]);
  });
});

describe("delivery-slot-notifier — schema validity (both sides)", () => {
  test("the COMPILED entity is schema-valid", async () => {
    await assertValid(object);
  });
  test("the HAND-WRITTEN gold is schema-valid", async () => {
    const { valid, errors } = await validate(parse(gold));
    if (!valid) console.error(errors);
    expect(valid).toBe(true);
  });
});

describe("delivery-slot-notifier — nj value-equivalence (compiled vs gold)", () => {
  for (const key of Object.keys(mineNotify)) {
    test(`"${key}" renders identically to the gold across the fallback matrix`, () => {
      for (const ctx of ctxFixtures) {
        expect(renderNj(inner(mineNotify[key]!), ctx)).toBe(renderNj(inner(goldNotify[key]!), ctx));
      }
    });
  }

  test("each compiled nj agrees with its TS oracle (assertDifferentialNj)", () => {
    assertDifferentialNj(
      nj((c: NotifierCtx) => c.parameters.requestedSlot ?? "next-available"),
      ctxFixtures,
    );
    assertDifferentialNj(
      nj((c: NotifierCtx) => (c.parameters.contactName || c.steps["fetch-baker"].output.name).toUpperCase()),
      ctxFixtures,
    );
    assertDifferentialNj(
      nj((c: NotifierCtx) => (c.parameters.urgency >= 3 ? "URGENT" : "standard")),
      ctxFixtures,
    );
    assertDifferentialNj(
      nj((c: NotifierCtx) => c.steps["fetch-baker"].output.name.split("-")[0]),
      ctxFixtures,
    );
  });
});

describe("delivery-slot-notifier — the ?? outcomes (invariant a)", () => {
  test("present / null / absent / empty-string give three DISTINCT slot outcomes", () => {
    const render = (ctx: NotifierCtx) => renderNj(inner(mineNotify.slot!), ctx);
    const present = render(ctxFixtures[0]!); // "9am-slot"
    const nullish = render(ctxFixtures[1]!); // null   → "next-available"
    const absent = render(ctxFixtures[2]!); // absent  → "next-available"
    const empty = render(ctxFixtures[3]!); // ""       → "" (passes through)

    expect(present).toBe("9am-slot");
    // null AND absent both fall back — the `??` is null-AND-missing aware.
    expect(nullish).toBe("next-available");
    expect(absent).toBe("next-available");
    // "" is the THIRD, distinct outcome — `??` does NOT fire on an empty string.
    expect(empty).toBe("");
    expect(new Set([present, nullish, empty]).size).toBe(3);
  });
});

describe("delivery-slot-notifier — the uppercase fallback (invariant b)", () => {
  test("a NAMED contact renders unchanged; only a missing one falls back to the baker", () => {
    const render = (ctx: NotifierCtx) => renderNj(inner(mineNotify.recipient!), ctx);
    // Named contact → the contact wins (upper-cased), NOT the baker name.
    expect(render(ctxFixtures[0]!)).toBe("BAKER SAM");
    // Missing contact → falls back to the fetched baker name (upper-cased).
    expect(render(ctxFixtures[1]!)).toBe("WEST-PARK-BAKERY");
  });
});

describe("delivery-slot-notifier — whole-run agreement vs the gold", () => {
  for (const scenario of scenarios) {
    test(`execute agrees with the gold — ${scenario.name}`, async () => {
      await assertExecuteAgainstGold(DeliverySlotNotifier, gold, scenario.fixture);
    });
  }

  test("a named-contact run keeps the contact (does not fall back)", async () => {
    const run = await execute(DeliverySlotNotifier, {
      parameters: { requestedSlot: "9am-slot", contactName: "Baker Sam", urgency: 4 },
      steps: { "fetch-baker": { output: { name: "north-riverside-bakery" } } },
    });
    const input = run.steps.notify!.input as { recipient: string; slot: string };
    expect(input.recipient).toBe("BAKER SAM");
    expect(input.slot).toBe("9am-slot");
  });
});
