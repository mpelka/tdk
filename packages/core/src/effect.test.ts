// Runtime + compile tests for `effect` and the v2 `defineTemplate` surface
// (ADR-0025 Decision 3 & 4, phase 3b): effect → step, output sub-refs, v2 planning
// (declaration order, `after:`, data dependency, interleaved derives), the ui:order
// inference, the escape hatch, `.when()` on effects, and the loud both-shapes /
// missing-pages guards.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { compile } from "./compile.ts";
import { defineTemplate } from "./define.ts";
import { _resetDeriveRegistry, derive } from "./derive.ts";
import { effect, isEffectHandle, rawEffect } from "./effects.ts";
import { execute } from "./execute.ts";
import { nj } from "./expr/nunjucks/index.ts";
import { page } from "./pages.ts";
import { p } from "./params.ts";

const target = { env: "test", outDir: "" } as const;

// Fresh registry per test, and a clean registry left behind for LATER-loaded
// test files (the registry is process-wide and test-file order is
// platform-dependent — see derive.test.ts's hygiene note).
beforeEach(() => {
  _resetDeriveRegistry();
});
afterAll(() => {
  _resetDeriveRegistry();
});

describe("effect — the handle and its output refs", () => {
  test("isEffectHandle detects a handle; output navigates to `${{ steps['id'].output... }}`", () => {
    const h = effect<{ body: { url: string } }>("open", "svc:raise", {});
    expect(isEffectHandle(h)).toBe(true);
    expect(isEffectHandle({})).toBe(false);
    expect(String(h.output)).toBe("${{ steps['open'].output }}");
    expect(String(h.output.body)).toBe("${{ steps['open'].output.body }}");
    expect(String(h.output.body.url)).toBe("${{ steps['open'].output.body.url }}");
  });

  test("a non-identifier output sub-ref key throws at access (the shared injection guard)", () => {
    const h = effect("guarded", "svc:raise", {});
    const probe = h.output as unknown as Record<string, unknown>;
    expect(() => probe["x'] }} injected {{ '"]).toThrow(/not a plain identifier/);
    expect(() => probe["a b"]).toThrow('effect "guarded" output');
  });

  test("an effect compiles to its action step; a bare param input normalizes to its .ref", () => {
    const site = p.choice(["BK1", "BK2"], { title: "Site", required: true });
    const ticket = effect("open", "svc:raise", { name: "Raise it", input: { site } });
    const tpl = defineTemplate({
      id: "e1",
      title: "E1",
      type: "service",
      pages: [page("P", { site })],
      effects: [ticket],
    });
    const { object } = compile(tpl, target);
    const step = object.spec.steps.find((s) => s.id === "open")!;
    expect(step.action).toBe("svc:raise");
    expect(step.name).toBe("Raise it");
    expect(step.input).toEqual({ site: "${{ parameters.site }}" });
  });
});

describe("effect — v2 planning", () => {
  test("derives referenced by an effect are collected and planned in front of it", () => {
    const severity = p.choice(["low", "urgent"], { title: "Severity", required: true });
    const sla = derive("sla-hours", { severity }, (i) => (i.severity === "urgent" ? 4 : 24));
    const ticket = effect("open", "svc:raise", { input: { slaHours: sla, site: severity } });
    const tpl = defineTemplate({
      id: "e2",
      title: "E2",
      type: "service",
      pages: [page("P", { severity })],
      effects: [ticket],
    });
    const { object } = compile(tpl, target);
    expect(object.spec.steps.map((s) => s.id)).toEqual(["sla-hours", "open"]);
    const input = object.spec.steps.find((s) => s.id === "open")!.input as Record<string, string>;
    expect(input.slaHours).toBe("${{ steps['sla-hours'].output.result }}");
  });

  test("independent effect peers emit in effects-list DECLARATION order", () => {
    const x = p.string({ title: "X", required: true });
    const a = effect("a", "svc:a", { input: { v: x } });
    const b = effect("b", "svc:b", { input: { v: x } });
    const c = effect("c", "svc:c", { input: { v: x } });
    const tpl = defineTemplate({
      id: "e3",
      title: "E3",
      type: "service",
      pages: [page("P", { x })],
      effects: [a, b, c],
    });
    expect(compile(tpl, target).object.spec.steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  test("a data dependency (one effect reads another's output) orders them, ignoring declaration order", () => {
    const x = p.string({ title: "X", required: true });
    const first = effect<{ id: string }>("first", "svc:first", { input: { v: x } });
    // `second` reads `first`'s output, but is declared BEFORE it in the list.
    const second = effect("second", "svc:second", { input: { ref: first.output.id } });
    const tpl = defineTemplate({
      id: "e4",
      title: "E4",
      type: "service",
      pages: [page("P", { x })],
      effects: [second, first],
    });
    const order = compile(tpl, target).object.spec.steps.map((s) => s.id);
    expect(order.indexOf("first")).toBeLessThan(order.indexOf("second"));
  });

  test("`after:` overrides declaration order WITHOUT a data dependency", () => {
    const x = p.string({ title: "X", required: true });
    const a = effect("a", "svc:a", { input: { v: x } });
    // `b` is declared FIRST but must run AFTER `a` — with no data dependency.
    const b = effect("b", "svc:b", { input: { v: x }, after: [a] });
    const tpl = defineTemplate({
      id: "e5",
      title: "E5",
      type: "service",
      pages: [page("P", { x })],
      effects: [b, a],
    });
    const order = compile(tpl, target).object.spec.steps.map((s) => s.id);
    expect(order).toEqual(["a", "b"]);
  });

  test("an effect-only cycle (contradictory after:) throws the step-ordering wording, naming the members", () => {
    const x = p.string({ title: "X", required: true });
    // `after:` records the referenced effect's ID, so a seed handle can donate
    // "a"'s id to `b` before the real `a` (which is after `b`) exists — a → b → a.
    const aSeed = effect("a", "svc:a", { input: { v: x } });
    const b = effect("b", "svc:b", { input: { v: x }, after: [aSeed] });
    const a = effect("a", "svc:a", { input: { v: x }, after: [b] });
    const tpl = defineTemplate({
      id: "e5c",
      title: "E5c",
      type: "service",
      pages: [page("P", { x })],
      effects: [a, b],
    });
    // The cycle is purely between STEPS (effects) — the message must not claim a
    // derive depends on itself; it names the kind of each stuck member.
    expect(() => compile(tpl, target)).toThrow(/step-ordering cycle/);
    expect(() => compile(tpl, target)).toThrow('step "a"');
    expect(() => compile(tpl, target)).toThrow('step "b"');
    expect(() => compile(tpl, target)).toThrow(/data references and `after:` hints/);
  });

  test(".after(...) as a fluent method matches the `after:` option", () => {
    const x = p.string({ title: "X", required: true });
    const a = effect("a", "svc:a", { input: { v: x } });
    const b = effect("b", "svc:b", { input: { v: x } }).after(a);
    const tpl = defineTemplate({
      id: "e5b",
      title: "E5b",
      type: "service",
      pages: [page("P", { x })],
      effects: [b, a],
    });
    expect(compile(tpl, target).object.spec.steps.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("effect — .when() run condition", () => {
  test(".when(severity.is('urgent')) compiles to an if: and skips when falsy in execute", async () => {
    const severity = p.choice(["low", "urgent"], { title: "Severity", required: true });
    const notify = effect("notify", "svc:notify", { input: { msg: "urgent!" } }).when(severity.is("urgent"));
    const tpl = defineTemplate({
      id: "e6",
      title: "E6",
      type: "service",
      pages: [page("P", { severity })],
      effects: [notify],
    });
    const { object } = compile(tpl, target);
    expect(object.spec.steps.find((s) => s.id === "notify")!.if).toBe('${{ parameters.severity == "urgent" }}');

    const urgent = await execute(tpl, { parameters: { severity: "urgent" }, steps: { notify: { output: {} } } });
    expect(urgent.steps.notify!.skipped).toBeUndefined();
    const low = await execute(tpl, { parameters: { severity: "low" }, steps: { notify: { output: {} } } });
    expect(low.steps.notify!.skipped).toBe(true);
  });

  test(".when() twice (or when + if) throws — a condition is declared once", () => {
    const s = p.choice(["a", "b"], { title: "S" });
    expect(() => effect("x", "svc:x", {}).when(s.is("a")).when(s.is("b"))).toThrow(/already set/);
    expect(() => effect("y", "svc:y", { when: s.is("a"), if: "${{ true }}" })).toThrow(/both `if` and `when`/);
  });
});

describe("effect — the rawEffect escape hatch", () => {
  test("wraps a pre-built Step verbatim and drops it into the effects list", () => {
    const x = p.string({ title: "X", required: true });
    const raw = rawEffect({
      id: "manual",
      action: "svc:manual",
      name: "Hand-built",
      input: { v: nj((c) => c.parameters.x) },
    });
    const tpl = defineTemplate({
      id: "e7",
      title: "E7",
      type: "service",
      pages: [page("P", { x })],
      effects: [raw],
    });
    const step = compile(tpl, target).object.spec.steps.find((s) => s.id === "manual")!;
    expect(step.action).toBe("svc:manual");
    expect(step.name).toBe("Hand-built");
    expect(step.input).toEqual({ v: "${{ parameters.x }}" });
  });

  test("rawEffect requires the step to have an id", () => {
    expect(() => rawEffect({ action: "svc:x" })).toThrow(/needs an id/);
  });
});

describe("effect — the loud v2-shape guards", () => {
  // A loosely-typed alias, so we can exercise the RUNTIME guards with configs the
  // type system correctly rejects (both-shapes / missing pages) — no `any`.
  const defineLoose = defineTemplate as unknown as (cfg: Record<string, unknown>) => unknown;

  test("declaring both `effects:` and `steps:` throws (both-shapes-at-once)", () => {
    const x = p.string({ title: "X" });
    expect(() =>
      defineLoose({
        id: "bad",
        title: "Bad",
        type: "service",
        pages: [page("P", { x })],
        effects: [effect("e", "svc:e", {})],
        steps: () => [],
      }),
    ).toThrow(/must NOT also declare `steps`/);
  });

  test("a v2 template (effects:) without pages: throws", () => {
    expect(() =>
      defineLoose({ id: "nop", title: "No Pages", type: "service", effects: [effect("e", "svc:e", {})] }),
    ).toThrow(/must declare `pages:`/);
  });

  test("a declared-but-unreachable derive in a v2 template is warned (and not emitted)", () => {
    const x = p.string({ title: "X", required: true });
    const used = derive("used", { x }, (i) => i.x);
    derive("orphan", { x }, (i) => `${i.x}!`);
    const tpl = defineTemplate({
      id: "e8",
      title: "E8",
      type: "service",
      pages: [page("P", { x })],
      effects: [effect("open", "svc:raise", { input: { v: used } })],
    });
    const { object, diagnostics } = compile(tpl, target);
    expect(object.spec.steps.map((s) => s.id)).not.toContain("orphan");
    expect(diagnostics!.some((d) => d.includes('"orphan"') && d.includes("not reachable"))).toBe(true);
  });
});

describe("effect — output as a reachability root + handle-based output", () => {
  test("a derive reached ONLY by output is emitted; output reads effect + derive handles", () => {
    const x = p.string({ title: "X", required: true });
    const tag = derive("tag", { x }, (i) => `#${i.x}`);
    const ticket = effect<{ body: { url: string } }>("open", "svc:raise", { input: { v: x } });
    const tpl = defineTemplate({
      id: "e9",
      title: "E9",
      type: "service",
      pages: [page("P", { x })],
      effects: [ticket],
      output: { url: ticket.output.body.url, tag },
    });
    const { object } = compile(tpl, target);
    expect(object.spec.steps.map((s) => s.id)).toContain("tag");
    expect(object.spec.output).toEqual({
      url: "${{ steps['open'].output.body.url }}",
      tag: "${{ steps['tag'].output.result }}",
    });
  });
});
